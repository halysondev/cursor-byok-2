//! Orchestrates plugin capabilities: resources, model catalogs, and invocation.
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration, time::Instant};

use async_stream::try_stream;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use super::{
    catalog::{PluginCatalog, PluginEntry},
    data::PluginDataStore,
    descriptor::{
        parse_model_id, PluginDescriptor, PluginModelDescriptor, PluginProviderDescriptor,
        PluginResourceDescriptor, PluginResourceView, ProviderDefinition, ResourceActionResponse,
        ResourceActionResult, ResourceDefinition, ResourcePresentation, FORM_ADD_METHOD,
        OAUTH2_ADD_METHOD, OAUTH2_AUTHORIZATION_CODE_ADD_METHOD,
    },
    oauth_callback::{self, CallbackHandle, CallbackOutcome, CallbackRequest},
    quota,
    runtime::PluginRuntime,
    state::{now_ms, PluginStateStore, ResourceDraft, ResourcePatch, ResourceRecord, StoredModel},
    wire,
    worker::{PluginWorker, WorkerStreamItem},
};
use crate::{
    model::ModelInvocation,
    provider::ProviderStream,
    provider::{CallRecorder, ModelEvent},
    store::Store,
    Error, Result,
};

const OAUTH_SLOW_DOWN_STEP_MS: i64 = 5_000;
const MAX_IMPORT_DRAFTS: usize = 256;
/// Background refresh period for plugin resource quotas.
const QUOTA_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct PluginRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    store: Store,
    runtime: PluginRuntime,
    catalog: PluginCatalog,
    state: PluginStateStore,
    entries: RwLock<Option<Vec<PluginEntry>>>,
    workers: Mutex<HashMap<String, Arc<PluginWorker>>>,
    oauth_sessions: Mutex<HashMap<String, OAuthSession>>,
    preparation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pending_preparations: Mutex<HashMap<String, (ResourceRecord, serde_json::Value)>>,
    resource_operations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// One-line quota summaries consumed by the Cursor model catalog, keyed by `{plugin_id}/{resource_type}`.
    quota_summaries: RwLock<HashMap<String, String>>,
    rr_counter: std::sync::atomic::AtomicUsize,
}

struct OAuthSession {
    plugin_id: String,
    resource_type: String,
    method_id: String,
    session: serde_json::Value,
    expires_at_ms: i64,
    poll_interval_ms: i64,
    next_poll_at_ms: i64,
    flow: OAuthFlow,
}

enum OAuthFlow {
    DeviceCode,
    AuthorizationCode {
        redirect_uri: String,
        code_verifier: String,
        callback: CallbackHandle,
    },
}

enum OAuthPollWork {
    DeviceCode {
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    },
    AuthorizationCode {
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBeginResponse {
    pub session_id: String,
    pub user_code: Option<String>,
    pub verification_url: String,
    pub verification_url_complete: Option<String>,
    pub expires_at_ms: i64,
    pub poll_interval_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum OAuthPollResponse {
    #[serde(rename_all = "camelCase")]
    Pending { poll_interval_ms: i64 },
    #[serde(rename_all = "camelCase")]
    Completed {
        added: usize,
        updated: usize,
        model_sync_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Denied { message: Option<String> },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub added: usize,
    pub updated: usize,
    pub warnings: Vec<String>,
    pub model_sync_error: Option<String>,
}

/// Plugin model metadata a route branch needs when building a Recorder.
#[derive(Clone, Debug)]
pub struct PluginInvocationPlan {
    pub model: PluginModelDescriptor,
    pub request_url: String,
}

impl PluginRegistry {
    pub fn managed(store: Store, runtime: PluginRuntime, app_version: String) -> Result<Self> {
        let data = PluginDataStore::managed()?;
        Ok(Self {
            inner: Arc::new(RegistryInner {
                store,
                runtime,
                catalog: PluginCatalog::managed(app_version)?,
                state: PluginStateStore::new(data),
                entries: RwLock::new(None),
                workers: Mutex::new(HashMap::new()),
                oauth_sessions: Mutex::new(HashMap::new()),
                preparation_locks: Mutex::new(HashMap::new()),
                pending_preparations: Mutex::new(HashMap::new()),
                resource_operations: Mutex::new(HashMap::new()),
                quota_summaries: RwLock::new(HashMap::new()),
                rr_counter: std::sync::atomic::AtomicUsize::new(0),
            }),
        })
    }

    pub async fn plugins(&self) -> Vec<PluginDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return self
                .inner
                .catalog
                .manifests()
                .into_iter()
                .map(|(manifest, icon)| PluginDescriptor {
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    author: manifest.author,
                    icon,
                    providers: Vec::new(),
                    resources: Vec::new(),
                })
                .collect();
        };
        let mut plugins = Vec::new();
        for entry in self.entries(&executable).await {
            plugins.push(self.descriptor(&entry, &executable).await);
        }
        plugins
    }

    /// All plugin models that meet their invocation requirements; each enters the Cursor catalog independently.
    pub async fn configured_models(&self) -> Vec<PluginModelDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return Vec::new();
        };
        let disabled_models = self
            .inner
            .store
            .disabled_plugin_models()
            .await
            .unwrap_or_default();
        let overrides = self
            .inner
            .store
            .plugin_model_overrides()
            .await
            .unwrap_or_default();
        let mut models = Vec::new();
        for entry in self.entries(&executable).await {
            for provider in &entry.definition.providers {
                if !self.provider_configured(&entry, provider).await {
                    continue;
                }
                let stored = self
                    .inner
                    .state
                    .models(&entry.manifest.id, &provider.id)
                    .await
                    .unwrap_or_default();
                models.extend(
                    stored
                        .iter()
                        .filter(|model| model.enabled)
                        .filter_map(|model| {
                            let descriptor = PluginModelDescriptor::new(
                                &entry.manifest.id,
                                &entry.manifest.name,
                                &entry.icon,
                                provider,
                                model,
                            );
                            if disabled_models.contains(&descriptor.id) {
                                return None;
                            }
                            let descriptor = match overrides.get(&descriptor.id) {
                                Some(over) => descriptor.with_override(over),
                                None => descriptor,
                            };
                            Some(descriptor)
                        }),
                );
            }
        }
        models
    }

    pub async fn model_descriptor(&self, model_id: &str) -> Result<PluginModelDescriptor> {
        let (plugin_id, provider_id, upstream_id) = parse_model_id(model_id)
            .ok_or_else(|| Error::Provider(format!("invalid plugin model ID: {model_id}")))?;
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let provider = find_provider(&entry, provider_id)?;
        let stored = self
            .inner
            .state
            .models(plugin_id, provider_id)
            .await?
            .into_iter()
            .find(|model| model.id == upstream_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin model {model_id}")))?;
        let mut descriptor = PluginModelDescriptor::new(
            plugin_id,
            &entry.manifest.name,
            &entry.icon,
            provider,
            &stored,
        );
        let overrides = self.inner.store.plugin_model_overrides().await?;
        if let Some(over) = overrides.get(&descriptor.id) {
            descriptor = descriptor.with_override(over);
        }
        Ok(descriptor)
    }

    pub async fn plan_model(&self, model_id: &str) -> Result<PluginInvocationPlan> {
        let disabled_models = self
            .inner
            .store
            .disabled_plugin_models()
            .await
            .unwrap_or_default();
        if disabled_models.contains(model_id) {
            return Err(Error::Provider(format!(
                "plugin model '{model_id}' is disabled"
            )));
        }
        let model = self.model_descriptor(model_id).await?;
        let request_url = format!("plugin://{}/{}", model.plugin_id, model.provider_id);
        Ok(PluginInvocationPlan { model, request_url })
    }

    /// Unified Provider stream for plugin models: resourced providers get an ordered
    /// candidate list keyed on the conversation ID so a session keeps the same preferred
    /// account; on an auth failure before any event is emitted the same account is
    /// force-refreshed and retried once, then the next candidate takes over — as it does
    /// directly for a resource failure. Once events have been emitted no switch happens
    /// so the output is never duplicated.
    pub fn stream_model(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
        recorder: CallRecorder,
    ) -> ProviderStream {
        let registry = self.clone();
        Box::pin(try_stream! {
            let model_id = invocation.request.model.model_id.clone();
            let (plugin_id, provider_id, upstream_id) = parse_model_id(&model_id)
                .map(|(plugin, provider, model)| (plugin.to_owned(), provider.to_owned(), model.to_owned()))
                .ok_or_else(|| Error::Provider(format!("invalid plugin model ID: {model_id}")))?;
            let executable = registry.executable()?;
            let entry = registry.find_entry(&executable, &plugin_id).await?;
            let provider = find_provider(&entry, &provider_id)?.clone();
            let stored = registry.inner.state.models(&plugin_id, &provider_id).await?
                .into_iter()
                .find(|model| model.id == upstream_id)
                .ok_or_else(|| Error::RunNotFound(format!("plugin model {model_id}")))?;
            let candidates: Vec<(String, ResourceRecord)> = match &provider.resource_type {
                Some(resource_type) => registry
                    .select_resources(&plugin_id, resource_type, Some(&invocation.conversation_id))
                    .await?
                    .into_iter()
                    .map(|record| (resource_type.clone(), record))
                    .collect(),
                None => Vec::new(),
            };
            let request = wire::llm_request(&invocation)?;
            let worker = registry.worker(&entry, &executable).await;
            yield ModelEvent::Start { model_call_id: invocation.call_id.clone() };
            let attempts = candidates.len().max(1);
            let mut attempt = 0;
            let mut refreshed_current = false;
            let mut forced: Option<(String, ResourceRecord)> = None;
            loop {
                if cancellation.is_cancelled() {
                    Err(Error::Cancelled)?;
                }
                let resource = match forced.take() {
                    Some(prepared) => Some(prepared),
                    None => match candidates.get(attempt) {
                        Some((resource_type, record))
                            if find_resource(&entry, resource_type)?.can_prepare =>
                        {
                            let prepared = registry
                                .prepare_resource(
                                    &entry,
                                    &executable,
                                    resource_type,
                                    record.clone(),
                                    None,
                                )
                                .await?;
                            Some((resource_type.clone(), prepared))
                        }
                        other => other.cloned(),
                    },
                };
                let params = serde_json::json!({
                    "providerId": provider_id,
                    "model": stored.snapshot(),
                    "resource": resource.as_ref().map(|(resource_type, record)| record.snapshot(resource_type)),
                    "request": request,
                });
                let mut items = worker
                    .invoke_streaming("provider.invoke", params, cancellation.clone(), Some(recorder.clone()))
                    .await?;
                let mut emitted = false;
                let mut result_value: Option<serde_json::Value> = None;
                while let Some(item) = items.recv().await {
                    match item {
                        WorkerStreamItem::Event(event) => {
                            emitted = true;
                            yield wire::model_event(&event)?;
                        }
                        WorkerStreamItem::Result(result) => {
                            result_value = Some(result?);
                            break;
                        }
                    }
                }
                let Some(value) = result_value else {
                    Err(Error::Provider(format!("plugin '{plugin_id}' worker stopped mid-stream")))?
                };
                let status = value
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let patch = value.get("patch")
                    .filter(|patch| !patch.is_null())
                    .map(|patch| serde_json::from_value::<ResourcePatch>(patch.clone()))
                    .transpose()?;
                if let (Some(patch), Some((resource_type, record))) = (patch, resource.as_ref()) {
                    registry
                        .inner
                        .state
                        .apply_patch_if_current(&plugin_id, resource_type, record, patch)
                        .await?;
                }
                match status {
                    "completed" => return,
                    "auth-error" | "resource-error" => {
                        let message = value.get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("plugin provider call failed")
                            .to_owned();
                        let can_prepare = resource
                            .as_ref()
                            .is_some_and(|(resource_type, _)| {
                                find_resource(&entry, resource_type)
                                    .is_ok_and(|resource| resource.can_prepare)
                            });
                        match next_stream_step(
                            status,
                            emitted,
                            refreshed_current,
                            can_prepare,
                            attempt + 1 < attempts,
                        ) {
                            StreamAttemptStep::RetryAfterRefresh => {
                                let Some((resource_type, record)) = candidates.get(attempt)
                                else {
                                    Err(Error::Provider(message))?
                                };
                                let prepared = registry
                                    .prepare_resource(
                                        &entry,
                                        &executable,
                                        resource_type,
                                        record.clone(),
                                        Some(record.clone()),
                                    )
                                    .await?;
                                tracing::warn!(
                                    plugin = %plugin_id,
                                    account = %record.key,
                                    %message,
                                    "plugin account rejected pre-output; retrying after a forced credential refresh"
                                );
                                forced = Some((resource_type.clone(), prepared));
                                refreshed_current = true;
                                continue;
                            }
                            StreamAttemptStep::Failover => {
                                tracing::warn!(
                                    plugin = %plugin_id,
                                    account = %resource.as_ref().map(|(_, record)| record.key.as_str()).unwrap_or_default(),
                                    %message,
                                    "plugin account failed before any event; failing over to the next candidate"
                                );
                                attempt += 1;
                                refreshed_current = false;
                                continue;
                            }
                            StreamAttemptStep::Fail => {
                                Err(Error::Provider(message))?;
                            }
                        }
                    }
                    "request-error" => {
                        let message = value.get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("plugin provider call failed");
                        Err(Error::Provider(message.to_owned()))?;
                    }
                    status => {
                        Err(Error::Protocol(format!("unknown plugin provider result: {status}")))?;
                    }
                }
            }
        })
    }

    pub async fn oauth_begin(
        &self,
        plugin_id: &str,
        resource_type: &str,
        method_id: &str,
    ) -> Result<OAuthBeginResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let method = resource
            .add
            .iter()
            .find(|method| method.id == method_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "plugin '{plugin_id}' does not define OAuth method '{method_id}'"
                ))
            })?;
        // Only one active lifecycle per add entry point. On restart, drop the old session first;
        // dropping the CallbackHandle of an auth-code session releases the loopback listener immediately.
        self.inner.oauth_sessions.lock().await.retain(|_, session| {
            session.plugin_id != plugin_id
                || session.resource_type != resource_type
                || session.method_id != method_id
        });
        let worker = self.worker(&entry, &executable).await;
        let session_id = uuid::Uuid::new_v4().to_string();

        let (
            session,
            verification_url,
            verification_url_complete,
            expires_at_ms,
            poll_interval_ms,
            flow,
            user_code,
        ) = match method.method_type.as_str() {
            OAUTH2_ADD_METHOD => {
                let value = worker
                    .invoke(
                        "oauth.begin",
                        serde_json::json!({
                            "resourceType": resource_type,
                            "methodId": method.id,
                        }),
                        CancellationToken::new(),
                    )
                    .await?;
                let begin: OAuth2Begin = serde_json::from_value(value)?;
                (
                    begin.session,
                    begin.verification_url,
                    begin.verification_url_complete,
                    begin.expires_at_ms,
                    begin.poll_interval_ms.max(1_000),
                    OAuthFlow::DeviceCode,
                    Some(begin.user_code),
                )
            }
            OAUTH2_AUTHORIZATION_CODE_ADD_METHOD => {
                let state = oauth_random_secret();
                let code_verifier = oauth_random_secret();
                let code_challenge =
                    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
                let callback = method.callback.as_ref();
                let callback = oauth_callback::bind(
                    callback.and_then(|value| value.port),
                    callback
                        .and_then(|value| value.path.as_deref())
                        .unwrap_or("/oauth-callback"),
                    state.clone(),
                    entry.manifest.name.clone(),
                    entry.icon.clone(),
                    serde_json::to_value(&resource.display_name)?,
                )
                .await?;
                let redirect_uri = callback.redirect_uri.clone();
                let value = worker
                    .invoke(
                        "oauth.begin",
                        serde_json::json!({
                            "resourceType": resource_type,
                            "methodId": method.id,
                            "authorization": {
                                "redirectUri": redirect_uri,
                                "state": state,
                                "codeChallenge": code_challenge,
                            },
                        }),
                        CancellationToken::new(),
                    )
                    .await?;
                let begin: OAuth2AuthorizationCodeBegin = serde_json::from_value(value)?;
                let poll_interval_ms = begin.poll_interval_ms.unwrap_or(1_000).max(1_000);
                (
                    begin.session,
                    begin.authorization_url,
                    None,
                    begin.expires_at_ms,
                    poll_interval_ms,
                    OAuthFlow::AuthorizationCode {
                        redirect_uri,
                        code_verifier,
                        callback,
                    },
                    None,
                )
            }
            method_type => {
                return Err(Error::Config(format!(
                        "plugin '{plugin_id}' OAuth method '{method_id}' uses unsupported type '{method_type}'"
                    )));
            }
        };

        if expires_at_ms <= now_ms() {
            return Err(Error::Protocol(format!(
                "plugin '{plugin_id}' OAuth method '{method_id}' returned an expired session"
            )));
        }
        self.inner.oauth_sessions.lock().await.insert(
            session_id.clone(),
            OAuthSession {
                plugin_id: plugin_id.to_owned(),
                resource_type: resource_type.to_owned(),
                method_id: method_id.to_owned(),
                session,
                expires_at_ms,
                poll_interval_ms,
                next_poll_at_ms: now_ms() + poll_interval_ms,
                flow,
            },
        );
        let cleanup = self.clone();
        let cleanup_session_id = session_id.clone();
        let cleanup_delay_ms = expires_at_ms.saturating_sub(now_ms()) as u64;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(cleanup_delay_ms)).await;
            cleanup
                .inner
                .oauth_sessions
                .lock()
                .await
                .remove(&cleanup_session_id);
        });
        Ok(OAuthBeginResponse {
            session_id,
            user_code,
            verification_url,
            verification_url_complete,
            expires_at_ms,
            poll_interval_ms,
        })
    }

    pub async fn oauth_poll(&self, session_id: &str) -> Result<OAuthPollResponse> {
        let work = {
            let now = now_ms();
            let mut sessions = self.inner.oauth_sessions.lock().await;
            let Some(state) = sessions.get_mut(session_id) else {
                return Ok(OAuthPollResponse::Failed {
                    message: "authorization session no longer exists".into(),
                });
            };
            if now >= state.expires_at_ms {
                sessions.remove(session_id);
                return Ok(OAuthPollResponse::Failed {
                    message: "authorization expired".into(),
                });
            }
            if now < state.next_poll_at_ms {
                return Ok(OAuthPollResponse::Pending {
                    poll_interval_ms: state.poll_interval_ms,
                });
            }
            state.next_poll_at_ms = now + state.poll_interval_ms;

            let common = (
                state.plugin_id.clone(),
                state.resource_type.clone(),
                state.method_id.clone(),
                state.session.clone(),
            );
            match &mut state.flow {
                OAuthFlow::DeviceCode => OAuthPollWork::DeviceCode {
                    plugin_id: common.0,
                    resource_type: common.1,
                    method_id: common.2,
                    session: common.3,
                    poll_interval_ms: state.poll_interval_ms,
                },
                OAuthFlow::AuthorizationCode {
                    redirect_uri,
                    code_verifier,
                    callback,
                } => match callback.receiver.try_recv() {
                    Ok(callback_request) => OAuthPollWork::AuthorizationCode {
                        plugin_id: common.0,
                        resource_type: common.1,
                        method_id: common.2,
                        session: common.3,
                        redirect_uri: redirect_uri.clone(),
                        code_verifier: code_verifier.clone(),
                        callback_request,
                    },
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                        return Ok(OAuthPollResponse::Pending {
                            poll_interval_ms: state.poll_interval_ms,
                        });
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                        sessions.remove(session_id);
                        return Ok(OAuthPollResponse::Failed {
                            message: "authorization callback stopped before completion".into(),
                        });
                    }
                },
            }
        };

        match work {
            OAuthPollWork::DeviceCode {
                plugin_id,
                resource_type,
                method_id,
                session,
                poll_interval_ms,
            } => {
                self.poll_device_code(
                    session_id,
                    plugin_id,
                    resource_type,
                    method_id,
                    session,
                    poll_interval_ms,
                )
                .await
            }
            OAuthPollWork::AuthorizationCode {
                plugin_id,
                resource_type,
                method_id,
                session,
                redirect_uri,
                code_verifier,
                callback_request,
            } => {
                self.complete_authorization_code(
                    session_id,
                    plugin_id,
                    resource_type,
                    method_id,
                    session,
                    redirect_uri,
                    code_verifier,
                    callback_request,
                )
                .await
            }
        }
    }

    async fn poll_device_code(
        &self,
        session_id: &str,
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    ) -> Result<OAuthPollResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, &plugin_id).await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "oauth.poll",
                serde_json::json!({
                    "resourceType": resource_type,
                    "methodId": method_id,
                    "session": session,
                }),
                CancellationToken::new(),
            )
            .await?;
        let poll: OAuth2Poll = serde_json::from_value(value)?;
        match poll {
            OAuth2Poll::Pending { session } => {
                self.update_session(session_id, session, None).await;
                Ok(OAuthPollResponse::Pending { poll_interval_ms })
            }
            OAuth2Poll::SlowDown { session } => {
                let interval = poll_interval_ms + OAUTH_SLOW_DOWN_STEP_MS;
                self.update_session(session_id, session, Some(interval))
                    .await;
                Ok(OAuthPollResponse::Pending {
                    poll_interval_ms: interval,
                })
            }
            OAuth2Poll::Completed { resources } => {
                // Destroy the device-code session only after persistence succeeds: a transient
                // write failure still lets the next poll retry.
                let response = self
                    .persist_oauth_resources(
                        &entry,
                        &executable,
                        &plugin_id,
                        &resource_type,
                        resources,
                    )
                    .await?;
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(response)
            }
            OAuth2Poll::Denied { message } => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(OAuthPollResponse::Denied { message })
            }
            OAuth2Poll::Failed { message } => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                Ok(OAuthPollResponse::Failed { message })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn complete_authorization_code(
        &self,
        session_id: &str,
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    ) -> Result<OAuthPollResponse> {
        let CallbackRequest { result, response } = callback_request;
        let code = match result {
            Ok(code) => code,
            Err(message) => {
                self.inner.oauth_sessions.lock().await.remove(session_id);
                let _ = response.send(CallbackOutcome {
                    success: false,
                    message: Some(message.clone()),
                });
                return Ok(OAuthPollResponse::Denied {
                    message: Some(message),
                });
            }
        };

        let result = async {
            let executable = self.executable()?;
            let entry = self.find_entry(&executable, &plugin_id).await?;
            let value = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "oauth.complete",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "methodId": method_id,
                        "session": session,
                        "authorization": {
                            "code": code,
                            "redirectUri": redirect_uri,
                            "codeVerifier": code_verifier,
                        },
                    }),
                    CancellationToken::new(),
                )
                .await?;
            let resources: Vec<ResourceDraft> = serde_json::from_value(value)?;
            self.persist_oauth_resources(&entry, &executable, &plugin_id, &resource_type, resources)
                .await
        }
        .await;

        self.inner.oauth_sessions.lock().await.remove(session_id);
        match result {
            Ok(completed) => {
                let _ = response.send(CallbackOutcome {
                    success: true,
                    message: None,
                });
                Ok(completed)
            }
            Err(error) => {
                let message = error.to_string();
                let _ = response.send(CallbackOutcome {
                    success: false,
                    message: Some(message.clone()),
                });
                Ok(OAuthPollResponse::Failed { message })
            }
        }
    }

    async fn persist_oauth_resources(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        plugin_id: &str,
        resource_type: &str,
        resources: Vec<ResourceDraft>,
    ) -> Result<OAuthPollResponse> {
        let outcome = self
            .inner
            .state
            .upsert_resources(plugin_id, resource_type, resources)
            .await?;
        let model_sync_error = self
            .sync_provider_models_for_resource(entry, executable, resource_type)
            .await;
        Ok(OAuthPollResponse::Completed {
            added: outcome.added,
            updated: outcome.updated,
            model_sync_error,
        })
    }

    pub async fn import_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
        files: serde_json::Value,
    ) -> Result<ImportResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if resource.import.is_none() {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support import"
            )));
        }
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "import.parse",
                serde_json::json!({ "resourceType": resource_type, "files": files }),
                CancellationToken::new(),
            )
            .await?;
        let parsed: ImportParseResult = serde_json::from_value(value)?;
        if parsed.resources.is_empty() {
            return Err(Error::Config(
                parsed
                    .warnings
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "import produced no resources".into()),
            ));
        }
        if parsed.resources.len() > MAX_IMPORT_DRAFTS {
            return Err(Error::Config(format!(
                "import produced more than {MAX_IMPORT_DRAFTS} resources"
            )));
        }
        let outcome = self
            .inner
            .state
            .upsert_resources(plugin_id, resource_type, parsed.resources)
            .await?;
        let model_sync_error = self
            .sync_provider_models_for_resource(&entry, &executable, resource_type)
            .await;
        Ok(ImportResponse {
            added: outcome.added,
            updated: outcome.updated,
            warnings: parsed.warnings,
            model_sync_error,
        })
    }

    pub async fn submit_form(
        &self,
        plugin_id: &str,
        resource_type: &str,
        method_id: &str,
        values: serde_json::Value,
    ) -> Result<ImportResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let method = resource
            .add
            .iter()
            .find(|method| method.id == method_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "plugin '{plugin_id}' does not define add method '{method_id}'"
                ))
            })?;
        if method.method_type != FORM_ADD_METHOD {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' add method '{method_id}' is not a form"
            )));
        }
        let values = values
            .as_object()
            .ok_or_else(|| Error::Config("form values must be an object".into()))?;
        for field in method.fields.as_deref().unwrap_or_default() {
            if field.required
                && values
                    .get(&field.id)
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|value| value.trim().is_empty())
            {
                return Err(Error::Config(format!(
                    "form field '{}' is required",
                    field.id
                )));
            }
        }
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "form.submit",
                serde_json::json!({
                    "resourceType": resource_type,
                    "methodId": method.id,
                    "values": values,
                }),
                CancellationToken::new(),
            )
            .await?;
        let resources: Vec<ResourceDraft> = serde_json::from_value(value)?;
        if resources.is_empty() {
            return Err(Error::Config("form produced no resources".into()));
        }
        if resources.len() > MAX_IMPORT_DRAFTS {
            return Err(Error::Config(format!(
                "form produced more than {MAX_IMPORT_DRAFTS} resources"
            )));
        }
        let outcome = self
            .inner
            .state
            .upsert_resources(plugin_id, resource_type, resources)
            .await?;
        let model_sync_error = self
            .sync_provider_models_for_resource(&entry, &executable, resource_type)
            .await;
        Ok(ImportResponse {
            added: outcome.added,
            updated: outcome.updated,
            warnings: Vec::new(),
            model_sync_error,
        })
    }

    /// Export all private data of a resource type for backup or migration; the format is bulk-import compatible.
    pub async fn export_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        find_resource(&entry, resource_type)?;
        let records = self.inner.state.resources(plugin_id, resource_type).await?;
        Ok(serde_json::json!({
            "accounts": records
                .iter()
                .map(|record| record.private_data.clone())
                .collect::<Vec<_>>(),
        }))
    }

    /// Runs opt-in resource refreshes until the server shuts down.
    /// Stops every plugin worker; called during server shutdown.
    pub async fn shutdown(&self) {
        let workers = self.inner.workers.lock().await;
        for worker in workers.values() {
            worker.stop().await;
        }
    }

    pub async fn run_background_resource_refresh(&self, shutdown: CancellationToken) {
        let targets = loop {
            let Some(executable) = self.inner.runtime.executable() else {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_secs(1)) => continue,
                }
            };
            break self
                .entries(&executable)
                .await
                .into_iter()
                .flat_map(|entry| {
                    entry
                        .definition
                        .resources
                        .into_iter()
                        .filter_map(move |resource| {
                            refresh_interval(&resource).map(|interval| {
                                (entry.manifest.id.clone(), resource.resource_type, interval)
                            })
                        })
                })
                .collect::<Vec<_>>();
        };
        let mut due = targets
            .iter()
            .map(|(_, _, interval)| Instant::now() + *interval)
            .collect::<Vec<_>>();
        while !targets.is_empty() {
            let next = *due.iter().min().expect("refresh targets are non-empty");
            if !wait_for_refresh(next, &shutdown).await {
                return;
            }
            for (index, (plugin_id, resource_type, interval)) in targets.iter().enumerate() {
                if due[index] > Instant::now() {
                    continue;
                }
                due[index] = Instant::now() + *interval;
                let records = match self.inner.state.resources(plugin_id, resource_type).await {
                    Ok(records) => records,
                    Err(error) => {
                        tracing::warn!(plugin = %plugin_id, resource_type, %error, "failed to load resources for refresh");
                        continue;
                    }
                };
                for record in records.into_iter().filter(|record| {
                    !matches!(record.state, super::state::ResourceState::Invalid { .. })
                }) {
                    if let Err(error) = self
                        .refresh_resource_with_cancellation(
                            plugin_id,
                            resource_type,
                            &record.id,
                            shutdown.clone(),
                        )
                        .await
                    {
                        if !matches!(error, Error::Cancelled) {
                            tracing::warn!(plugin = %plugin_id, resource_type, resource_id = %record.id, %error, "background resource refresh failed");
                        }
                    }
                    if shutdown.is_cancelled() {
                        return;
                    }
                }
            }
        }
    }

    async fn resource_operation_lock(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Arc<Mutex<()>> {
        let mut locks = self.inner.resource_operations.lock().await;
        locks
            .entry(format!("{plugin_id}\u{0}{resource_type}"))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn refresh_resource_with_cancellation(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
        cancellation: CancellationToken,
    ) -> Result<()> {
        let lock = self.resource_operation_lock(plugin_id, resource_type).await;
        let _guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(Error::Cancelled),
            guard = lock.lock() => guard,
        };
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(Error::Cancelled),
            result = self.refresh_resource_locked(plugin_id, resource_type, resource_id, cancellation.clone()) => result,
        }
    }

    async fn refresh_resource_locked(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
        cancellation: CancellationToken,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if !resource.can_refresh {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support refresh"
            )));
        }
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        self.refresh_record(&entry, &executable, resource_type, &record, cancellation)
            .await
    }

    /// Starts the background quota refresh loop: refreshes every refreshable
    /// resource once a minute and writes the aggregated summary into the cache
    /// for the Cursor model catalog to append to plugin model hover remarks.
    /// The first interval tick fires immediately; ticks while the runtime is not
    /// ready are skipped.
    pub fn start_quota_refresh(&self) {
        let registry = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(QUOTA_REFRESH_INTERVAL);
            loop {
                interval.tick().await;
                registry.refresh_quota_summaries().await;
            }
        });
    }

    /// The one-line quota summary consumed by the Cursor model catalog; None when
    /// the provider has no resource type or no quota data.
    pub async fn quota_summary(&self, plugin_id: &str, provider_id: &str) -> Option<String> {
        let executable = self.inner.runtime.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await.ok()?;
        let resource_type = find_provider(&entry, provider_id)
            .ok()?
            .resource_type
            .as_deref()?;
        let key = quota_key(plugin_id, resource_type);
        self.inner.quota_summaries.read().await.get(&key).cloned()
    }

    /// One refresh round: for each refreshable resource type, call the plugin's
    /// refresh per account and persist the result, then aggregate the present
    /// projection into a single summary line; the whole round replaces the cache.
    async fn refresh_quota_summaries(&self) {
        let Some(executable) = self.inner.runtime.executable() else {
            return;
        };
        let disabled = self
            .inner
            .store
            .disabled_plugin_accounts()
            .await
            .unwrap_or_default();
        let mut summaries = HashMap::new();
        for entry in self.entries(&executable).await {
            let plugin_id = entry.manifest.id.clone();
            for definition in &entry.definition.resources {
                if !definition.can_refresh {
                    continue;
                }
                let resource_type = definition.resource_type.as_str();
                let records = match self.inner.state.resources(&plugin_id, resource_type).await {
                    Ok(records) => records,
                    Err(error) => {
                        tracing::warn!(plugin = %plugin_id, %error, "cannot load plugin resources for quota refresh");
                        continue;
                    }
                };
                let enabled: Vec<ResourceRecord> = records
                    .into_iter()
                    .filter(|record| !disabled.contains(&record.id))
                    .collect();
                if enabled.is_empty() {
                    continue;
                }
                for record in &enabled {
                    if let Err(error) = self
                        .refresh_record(
                            &entry,
                            &executable,
                            resource_type,
                            record,
                            CancellationToken::new(),
                        )
                        .await
                    {
                        tracing::warn!(plugin = %plugin_id, account = %record.key, %error, "plugin quota refresh failed");
                    }
                }
                // Re-read to pick up the latest private_data written by refresh.
                let records = self
                    .inner
                    .state
                    .resources(&plugin_id, resource_type)
                    .await
                    .unwrap_or_else(|_| enabled.clone());
                let enabled: Vec<ResourceRecord> = records
                    .into_iter()
                    .filter(|record| !disabled.contains(&record.id))
                    .collect();
                let views = self
                    .present_resources(&entry, &executable, definition, &enabled)
                    .await;
                if let Some(line) = quota::quota_line(&views) {
                    summaries.insert(quota_key(&plugin_id, resource_type), line);
                }
            }
        }
        *self.inner.quota_summaries.write().await = summaries;
    }

    /// Calls the plugin to refresh a single resource and persists the returned patch.
    async fn refresh_record(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        resource_type: &str,
        record: &ResourceRecord,
        cancellation: CancellationToken,
    ) -> Result<()> {
        let value = self
            .worker(entry, executable)
            .await
            .invoke(
                "resource.refresh",
                serde_json::json!({
                    "resourceType": resource_type,
                    "resource": record.snapshot(resource_type),
                }),
                cancellation,
            )
            .await?;
        let patch: ResourcePatch = serde_json::from_value(value)?;
        self.inner
            .state
            .apply_patch_if_current(&entry.manifest.id, resource_type, record, patch)
            .await?;
        if let Some(error) = self
            .sync_provider_models_for_resource(entry, executable, resource_type)
            .await
        {
            tracing::warn!(plugin = %entry.manifest.id, %error, "model sync after resource refresh failed");
        }
        Ok(())
    }

    pub async fn refresh_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if !resource.can_refresh {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support refresh"
            )));
        }
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        self.prepare_resource(&entry, &executable, resource_type, record.clone(), None)
            .await?;
        let lock = self
            .preparation_lock(plugin_id, resource_type, resource_id)
            .await;
        let _guard = lock.lock().await;
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.refresh",
                serde_json::json!({
                    "resourceType": resource_type,
                    "resource": record.snapshot(resource_type),
                }),
                CancellationToken::new(),
            )
            .await?;
        let patch: ResourcePatch = serde_json::from_value(value)?;
        self.inner
            .state
            .apply_patch_if_current(plugin_id, resource_type, &record, patch)
            .await
            .map(|_| ())
    }

    pub async fn resource_action(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
        action_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let action = resource
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "plugin '{plugin_id}' resource '{resource_type}' does not define action '{action_id}'"
                ))
            })?;
        if !matches!(action.target.as_str(), "resource" | "card") {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource action '{action_id}' has an invalid target"
            )));
        }
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.action",
                serde_json::json!({
                    "resourceType": resource_type,
                    "actionId": action_id,
                    "resource": record.snapshot(resource_type),
                    "input": input,
                }),
                CancellationToken::new(),
            )
            .await?;
        let result: ResourceActionResult = serde_json::from_value(value)?;
        if let Some(patch) = result.patch.clone() {
            self.inner
                .state
                .apply_patch_if_current(plugin_id, resource_type, &record, patch)
                .await?;
        }
        Ok(serde_json::to_value(ResourceActionResponse::from(result))?)
    }

    pub async fn delete_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        if resource.can_remove {
            // A failed upstream revocation must not block local deletion: users must be able to remove dead resources.
            if let Err(error) = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "resource.remove",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "resource": record.snapshot(resource_type),
                    }),
                    CancellationToken::new(),
                )
                .await
            {
                tracing::warn!(plugin = %plugin_id, %error, "plugin resource remove hook failed");
            }
        }
        self.inner
            .state
            .remove_resource(plugin_id, resource_type, resource_id)
            .await?;
        Ok(())
    }

    pub async fn sync_models(&self, plugin_id: &str, provider_id: &str) -> Result<usize> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let provider = find_provider(&entry, provider_id)?.clone();
        self.sync_provider_models(&entry, &executable, &provider)
            .await
    }

    pub async fn set_model_enabled(
        &self,
        plugin_id: &str,
        provider_id: &str,
        model_id: &str,
        enabled: bool,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let provider = find_provider(&entry, provider_id)?;
        if !provider.has_models {
            return Err(Error::Config(format!(
                "plugin provider '{provider_id}' does not enumerate models"
            )));
        }
        self.inner
            .state
            .set_model_enabled(plugin_id, provider_id, model_id, enabled)
            .await
    }

    pub async fn remove(&self, plugin_id: &str) -> Result<()> {
        if let Some(worker) = self.inner.workers.lock().await.remove(plugin_id) {
            worker.stop().await;
        }
        self.inner.state.clear(plugin_id).await
    }

    async fn descriptor(&self, entry: &PluginEntry, executable: &Path) -> PluginDescriptor {
        let plugin_id = &entry.manifest.id;
        let overrides = self
            .inner
            .store
            .plugin_model_overrides()
            .await
            .unwrap_or_default();
        let mut providers = Vec::new();
        for provider in &entry.definition.providers {
            let stored = self
                .inner
                .state
                .models(plugin_id, &provider.id)
                .await
                .unwrap_or_default();
            let configured = self.provider_configured(entry, provider).await;
            providers.push(PluginProviderDescriptor {
                id: provider.id.clone(),
                plugin_id: plugin_id.clone(),
                display_name: provider.display_name.clone(),
                description: provider.description.clone(),
                provider_type: provider.provider_type.clone(),
                resource_type: provider.resource_type.clone(),
                has_models: provider.has_models,
                configured,
                models: stored
                    .iter()
                    .map(|model| {
                        let descriptor = PluginModelDescriptor::new(
                            plugin_id,
                            &entry.manifest.name,
                            &entry.icon,
                            provider,
                            model,
                        );
                        match overrides.get(&descriptor.id) {
                            Some(over) => descriptor.with_override(over),
                            None => descriptor,
                        }
                    })
                    .collect(),
            });
        }
        let mut resources = Vec::new();
        for definition in &entry.definition.resources {
            let records = self
                .inner
                .state
                .resources(plugin_id, &definition.resource_type)
                .await
                .unwrap_or_default();
            let views = self
                .present_resources(entry, executable, definition, &records)
                .await;
            resources.push(PluginResourceDescriptor {
                resource_type: definition.resource_type.clone(),
                display_name: definition.display_name.clone(),
                add: definition.add.clone(),
                import: definition.import.clone(),
                actions: definition.actions.clone(),
                can_refresh: definition.can_refresh,
                can_remove: definition.can_remove,
                resources: views,
            });
        }
        PluginDescriptor {
            id: plugin_id.clone(),
            name: entry.manifest.name.clone(),
            version: entry.manifest.version.clone(),
            author: entry.manifest.author.clone(),
            icon: entry.icon.clone(),
            providers,
            resources,
        }
    }

    async fn present_resources(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        definition: &ResourceDefinition,
        records: &[ResourceRecord],
    ) -> Vec<PluginResourceView> {
        if records.is_empty() {
            return Vec::new();
        }
        let snapshots = records
            .iter()
            .map(|record| record.snapshot(&definition.resource_type))
            .collect::<Vec<_>>();
        let presented = self
            .worker(entry, executable)
            .await
            .invoke(
                "resource.present",
                serde_json::json!({
                    "resourceType": definition.resource_type,
                    "resources": snapshots,
                }),
                CancellationToken::new(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<ResourcePresentation>>(value).map_err(Error::from)
            });
        match presented {
            Ok(views) if views.len() == records.len() => records
                .iter()
                .zip(views)
                .map(|(record, view)| PluginResourceView::from_record(record, view))
                .collect(),
            Ok(_) | Err(_) => records
                .iter()
                .map(|record| {
                    PluginResourceView::from_record(
                        record,
                        ResourcePresentation {
                            display_name: record.key.clone(),
                            description: serde_json::Value::Null,
                            metrics: Vec::new(),
                        },
                    )
                })
                .collect(),
        }
    }

    async fn provider_configured(
        &self,
        entry: &PluginEntry,
        provider: &ProviderDefinition,
    ) -> bool {
        let plugin_id = &entry.manifest.id;
        if provider.has_models {
            let models = self
                .inner
                .state
                .models(plugin_id, &provider.id)
                .await
                .unwrap_or_default();
            if models.is_empty() {
                return false;
            }
        }
        match &provider.resource_type {
            Some(resource_type) => {
                let disabled_accounts = self
                    .inner
                    .store
                    .disabled_plugin_accounts()
                    .await
                    .unwrap_or_default();
                let resources = self
                    .inner
                    .state
                    .resources(plugin_id, resource_type)
                    .await
                    .unwrap_or_default();
                resources.iter().any(|r| !disabled_accounts.contains(&r.id))
            }
            None => true,
        }
    }

    /// Once resources exist, refresh the model catalog of Providers using that resource type; failures are reported but non-fatal.
    async fn sync_provider_models_for_resource(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        resource_type: &str,
    ) -> Option<String> {
        let mut errors = Vec::new();
        for provider in entry.definition.providers.clone() {
            if provider.resource_type.as_deref() != Some(resource_type) || !provider.has_models {
                continue;
            }
            if let Err(error) = self
                .sync_provider_models(entry, executable, &provider)
                .await
            {
                errors.push(format!("{}: {error}", provider.id));
            }
        }
        (!errors.is_empty()).then(|| errors.join("; "))
    }

    async fn sync_provider_models(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        provider: &ProviderDefinition,
    ) -> Result<usize> {
        if !provider.has_models {
            return Err(Error::Config(format!(
                "plugin provider '{}' does not enumerate models",
                provider.id
            )));
        }
        let plugin_id = &entry.manifest.id;
        let resource = match &provider.resource_type {
            Some(resource_type) => {
                let record = self.select_resource(plugin_id, resource_type).await?;
                let record = self
                    .prepare_resource(entry, executable, resource_type, record, None)
                    .await?;
                Some(record.snapshot(resource_type))
            }
            None => None,
        };
        let value = self
            .worker(entry, executable)
            .await
            .invoke(
                "models.list",
                serde_json::json!({ "providerId": provider.id, "resource": resource }),
                CancellationToken::new(),
            )
            .await?;
        let definitions = value
            .as_array()
            .ok_or_else(|| Error::Protocol("plugin models.list must return an array".into()))?;
        let mut models = Vec::with_capacity(definitions.len());
        let mut seen = std::collections::HashSet::new();
        for definition in definitions {
            let model = StoredModel::from_definition(definition)?;
            if seen.insert(model.id.clone()) {
                models.push(model);
            }
        }
        if models.is_empty() {
            return Err(Error::Provider(format!(
                "plugin provider '{}' returned no models",
                provider.id
            )));
        }
        self.inner
            .state
            .replace_models(plugin_id, &provider.id, &models)
            .await?;
        Ok(models.len())
    }

    /// Candidate accounts are stably ordered by plan priority; with an affinity key
    /// (conversation ID) a hash picks the preferred candidate, so a session lands on the
    /// same account while the candidate set is unchanged and drifts naturally as cooling
    /// or disabled accounts drop out. The returned order is the failover order for one
    /// request.
    async fn select_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
        affinity: Option<&str>,
    ) -> Result<Vec<ResourceRecord>> {
        let disabled_accounts = self
            .inner
            .store
            .disabled_plugin_accounts()
            .await
            .unwrap_or_default();
        let records = self.inner.state.resources(plugin_id, resource_type).await?;
        let active_records: Vec<_> = records
            .into_iter()
            .filter(|record| !disabled_accounts.contains(&record.id))
            .collect();
        if active_records.is_empty() {
            return Err(Error::Provider(format!(
                "plugin '{plugin_id}' has no enabled '{resource_type}' resource; enable or add one first"
            )));
        }
        let now = now_ms();
        let mut ready_records: Vec<_> = active_records
            .into_iter()
            .filter(|record| record.state.is_ready(now))
            .collect();
        if ready_records.is_empty() {
            return Err(Error::Provider(format!(
                "all enabled accounts for plugin '{plugin_id}' are currently cooling or rate-limited"
            )));
        }

        let get_priority = |r: &ResourceRecord| -> u8 {
            let label = r
                .private_data
                .get("quota")
                .and_then(|q| q.get("planLabel"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            let lower = label.to_lowercase();
            if label.contains("🔥")
                || lower.contains("pro")
                || lower.contains("ultra")
                || lower.contains("premium")
                || lower.contains("advanced")
            {
                0
            } else {
                1
            }
        };

        // Plan tier first, ID as the tiebreaker, so the order is stable while the candidate set is unchanged.
        ready_records.sort_by(|a, b| {
            get_priority(a)
                .cmp(&get_priority(b))
                .then_with(|| a.id.cmp(&b.id))
        });
        let start = match affinity {
            Some(key) => affinity_index(key, ready_records.len()),
            None => {
                self.inner
                    .rr_counter
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                    % ready_records.len()
            }
        };
        ready_records.rotate_left(start);
        Ok(ready_records)
    }

    async fn select_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<ResourceRecord> {
        let mut candidates = self
            .select_resources(plugin_id, resource_type, None)
            .await?;
        Ok(candidates.remove(0))
    }

    async fn find_record(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<ResourceRecord> {
        self.inner
            .state
            .resources(plugin_id, resource_type)
            .await?
            .into_iter()
            .find(|record| record.id == resource_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin resource {resource_id}")))
    }

    async fn update_session(
        &self,
        session_id: &str,
        session: Option<serde_json::Value>,
        poll_interval_ms: Option<i64>,
    ) {
        let mut sessions = self.inner.oauth_sessions.lock().await;
        if let Some(state) = sessions.get_mut(session_id) {
            if let Some(session) = session {
                state.session = session;
            }
            if let Some(interval) = poll_interval_ms {
                state.poll_interval_ms = interval;
            }
        }
    }

    fn executable(&self) -> Result<std::path::PathBuf> {
        self.inner
            .runtime
            .executable()
            .ok_or_else(|| Error::Config("plugin runtime is not ready".into()))
    }

    async fn entries(&self, executable: &Path) -> Vec<PluginEntry> {
        if let Some(entries) = self.inner.entries.read().await.as_ref() {
            return entries.clone();
        }
        let mut cache = self.inner.entries.write().await;
        if let Some(entries) = cache.as_ref() {
            return entries.clone();
        }
        let loaded = self.inner.catalog.entries(executable).await;
        *cache = Some(loaded.clone());
        drop(cache);
        for entry in &loaded {
            for resource in entry
                .definition
                .resources
                .iter()
                .filter(|resource| resource.can_prepare)
            {
                let registry = self.clone();
                let entry = entry.clone();
                let executable = executable.to_path_buf();
                let kind = resource.resource_type.clone();
                tokio::spawn(async move {
                    let records = registry
                        .inner
                        .state
                        .resources(&entry.manifest.id, &kind)
                        .await
                        .unwrap_or_default();
                    for record in records {
                        if let Err(error) = registry
                            .prepare_resource(&entry, &executable, &kind, record, None)
                            .await
                        {
                            tracing::warn!(plugin = %entry.manifest.id, %error, "startup credential preparation failed");
                        }
                    }
                });
            }
        }
        loaded
    }

    async fn find_entry(&self, executable: &Path, plugin_id: &str) -> Result<PluginEntry> {
        self.entries(executable)
            .await
            .into_iter()
            .find(|entry| entry.manifest.id == plugin_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin {plugin_id}")))
    }

    async fn worker(&self, entry: &PluginEntry, executable: &Path) -> Arc<PluginWorker> {
        let mut workers = self.inner.workers.lock().await;
        workers
            .entry(entry.manifest.id.clone())
            .or_insert_with(|| {
                Arc::new(PluginWorker::new(
                    entry,
                    executable.to_path_buf(),
                    self.inner.catalog.loader().clone(),
                    self.inner.store.clone(),
                ))
            })
            .clone()
    }

    async fn preparation_lock(&self, plugin: &str, kind: &str, id: &str) -> Arc<Mutex<()>> {
        self.inner
            .preparation_locks
            .lock()
            .await
            .entry(format!("{plugin}/{kind}/{id}"))
            .or_default()
            .clone()
    }

    /// Once a refresh is issued, commit rotated credentials even if the model request is cancelled.
    async fn prepare_resource(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        kind: &str,
        record: ResourceRecord,
        rejected: Option<ResourceRecord>,
    ) -> Result<ResourceRecord> {
        if !find_resource(entry, kind)?.can_prepare {
            return Ok(record);
        }
        let registry = self.clone();
        let entry = entry.clone();
        let executable = executable.to_path_buf();
        let kind = kind.to_owned();
        tokio::spawn(async move {
            let plugin = &entry.manifest.id;
            let key = format!("{plugin}/{kind}/{}", record.id);
            let lock = registry.preparation_lock(plugin, &kind, &record.id).await;
            let _guard = lock.lock().await;
            // Retry failed persistence before ever exchanging another refresh token.
            let pending = registry
                .inner
                .pending_preparations
                .lock()
                .await
                .get(&key)
                .cloned();
            if let Some((snapshot, value)) = pending {
                registry
                    .inner
                    .state
                    .apply_patch_if_current(
                        plugin,
                        &kind,
                        &snapshot,
                        serde_json::from_value(value)?,
                    )
                    .await?;
                registry
                    .inner
                    .pending_preparations
                    .lock()
                    .await
                    .remove(&key);
            }
            let current = registry.find_record(plugin, &kind, &record.id).await?;
            let value = registry
                .worker(&entry, &executable)
                .await
                .invoke(
                    "resource.prepare",
                    serde_json::json!({
                        "resourceType": kind,
                        "resource": current.snapshot(&kind),
                        "rejectedResource": rejected.as_ref().map(|item| item.snapshot(&kind)),
                    }),
                    CancellationToken::new(),
                )
                .await?;
            let had_patch = !value.is_null();
            if had_patch {
                registry
                    .inner
                    .pending_preparations
                    .lock()
                    .await
                    .insert(key.clone(), (current.clone(), value.clone()));
                registry
                    .inner
                    .state
                    .apply_patch_if_current(plugin, &kind, &current, serde_json::from_value(value)?)
                    .await?;
                registry
                    .inner
                    .pending_preparations
                    .lock()
                    .await
                    .remove(&key);
            }
            let prepared = registry.find_record(plugin, &kind, &record.id).await?;
            if had_patch && !prepared.state.is_ready(now_ms()) {
                let message = match &prepared.state {
                    super::state::ResourceState::Invalid { message }
                    | super::state::ResourceState::Cooling { message, .. } => message.clone(),
                    _ => None,
                }
                .unwrap_or_else(|| "plugin account is not ready".into());
                return Err(Error::Provider(message));
            }
            Ok(prepared)
        })
        .await
        .map_err(|error| Error::Provider(format!("credential preparation task failed: {error}")))?
    }
}

fn refresh_interval(resource: &super::descriptor::ResourceDefinition) -> Option<Duration> {
    resource
        .refresh_interval_ms
        .filter(|interval| *interval > 0)
        .map(Duration::from_millis)
}

/// Waits until `deadline` or shutdown. Returns false when the shutdown won.
async fn wait_for_refresh(deadline: Instant, shutdown: &CancellationToken) -> bool {
    tokio::select! {
        () = shutdown.cancelled() => false,
        () = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => true,
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2Begin {
    session: serde_json::Value,
    user_code: String,
    verification_url: String,
    #[serde(default)]
    verification_url_complete: Option<String>,
    expires_at_ms: i64,
    poll_interval_ms: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2AuthorizationCodeBegin {
    session: serde_json::Value,
    authorization_url: String,
    expires_at_ms: i64,
    #[serde(default)]
    poll_interval_ms: Option<i64>,
}

fn oauth_random_secret() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "status")]
enum OAuth2Poll {
    #[serde(rename_all = "camelCase")]
    Pending {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    SlowDown {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Completed { resources: Vec<ResourceDraft> },
    #[serde(rename_all = "camelCase")]
    Denied {
        #[serde(default)]
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportParseResult {
    resources: Vec<ResourceDraft>,
    #[serde(default)]
    warnings: Vec<String>,
}

/// What the stream loop does after an account-level failure on the current candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamAttemptStep {
    /// Force-refresh the same candidate's credential and invoke it once more.
    RetryAfterRefresh,
    /// Move on to the next candidate account.
    Failover,
    /// Surface the failure.
    Fail,
}

/// A rejected-but-fresh-looking credential can still be stale, so an `auth-error` earns the
/// same account one forced re-prepare before failover; quota/resource failures move
/// straight to the next candidate, and nothing retries once events have been emitted.
fn next_stream_step(
    status: &str,
    emitted: bool,
    refreshed_current: bool,
    can_prepare: bool,
    has_next: bool,
) -> StreamAttemptStep {
    if emitted {
        return StreamAttemptStep::Fail;
    }
    match status {
        "auth-error" if !refreshed_current && can_prepare => StreamAttemptStep::RetryAfterRefresh,
        "auth-error" | "resource-error" if has_next => StreamAttemptStep::Failover,
        _ => StreamAttemptStep::Fail,
    }
}

#[cfg(test)]
mod stream_step_tests {
    use super::*;

    #[test]
    fn auth_error_refreshes_once_then_fails_over() {
        // First auth rejection on a preparable credential: force-refresh and retry same.
        assert_eq!(
            next_stream_step("auth-error", false, false, true, false),
            StreamAttemptStep::RetryAfterRefresh
        );
        // Same account already refreshed: fail over when another candidate exists.
        assert_eq!(
            next_stream_step("auth-error", false, true, true, true),
            StreamAttemptStep::Failover
        );
        // No candidate left: surface the failure.
        assert_eq!(
            next_stream_step("auth-error", false, true, true, false),
            StreamAttemptStep::Fail
        );
        // Unpreparable resources never earn a refresh retry.
        assert_eq!(
            next_stream_step("auth-error", false, false, false, true),
            StreamAttemptStep::Failover
        );
    }

    #[test]
    fn resource_errors_fail_over_without_refreshing() {
        assert_eq!(
            next_stream_step("resource-error", false, false, true, true),
            StreamAttemptStep::Failover
        );
        assert_eq!(
            next_stream_step("resource-error", false, false, true, false),
            StreamAttemptStep::Fail
        );
    }

    #[test]
    fn nothing_retries_once_events_are_emitted() {
        for status in ["auth-error", "resource-error", "request-error"] {
            assert_eq!(
                next_stream_step(status, true, false, true, true),
                StreamAttemptStep::Fail
            );
        }
        assert_eq!(
            next_stream_step("request-error", false, false, true, true),
            StreamAttemptStep::Fail
        );
    }
}

/// Preferred index for session affinity: constant for the same key while the candidate count is unchanged.
fn affinity_index(key: &str, len: usize) -> usize {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    (hasher.finish() as usize) % len
}

/// Quota summary cache key.
fn quota_key(plugin_id: &str, resource_type: &str) -> String {
    format!("{plugin_id}/{resource_type}")
}

fn find_provider<'a>(entry: &'a PluginEntry, provider_id: &str) -> Result<&'a ProviderDefinition> {
    entry
        .definition
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "plugin '{}' provider {provider_id}",
                entry.manifest.id
            ))
        })
}

fn find_resource<'a>(
    entry: &'a PluginEntry,
    resource_type: &str,
) -> Result<&'a ResourceDefinition> {
    entry
        .definition
        .resources
        .iter()
        .find(|resource| resource.resource_type == resource_type)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "plugin '{}' resource type {resource_type}",
                entry.manifest.id
            ))
        })
}

#[cfg(test)]
mod credential_lifecycle_tests {
    use super::*;

    async fn fixture() -> (
        tempfile::TempDir,
        PluginRegistry,
        PluginEntry,
        std::path::PathBuf,
        ResourceRecord,
    ) {
        let executable = std::path::PathBuf::from(
            std::env::var_os("DENO_TEST_EXECUTABLE").expect("set DENO_TEST_EXECUTABLE"),
        );
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("installed/test");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("plugin.json"), r#"{"apiVersion":1,"id":"dev.refresh","name":"Refresh test","version":"0.1.0","minAppVersion":"0.1.0","entry":"main.ts","icon":"icon.svg","permissions":{"network":[]}}"#).unwrap();
        std::fs::write(
            directory.join("icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        std::fs::write(directory.join("main.ts"), r#"
            import { defineProviderPlugin } from "cursor-byok:plugin";
            let exchanges = 0;
            export default defineProviderPlugin({
              providers: [{id:"fake",displayName:"fake",providerType:"test",resourceType:"account",invoke:async()=>({status:"completed"})}],
              resources: [{type:"account",displayName:"account",present:()=>({displayName:"test"}),
                prepare: async (resource) => {
                  if (resource.privateData.token.startsWith("fresh-")) return null;
                  const generation = ++exchanges;
                  await new Promise(resolve => setTimeout(resolve, 150));
                  return {privateData:{token:`fresh-${generation}`,refreshToken:`rotated-${generation}`},state:{status:"ready"}};
                }
              }]
            });
        "#).unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            root.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let state =
            PluginStateStore::new(PluginDataStore::for_test(root.path().join("data")).unwrap());
        state
            .upsert_resources(
                "dev.refresh",
                "account",
                vec![ResourceDraft {
                    key: "one".into(),
                    private_data: serde_json::json!({"token":"expired"}),
                    state: None,
                }],
            )
            .await
            .unwrap();
        let record = state
            .resources("dev.refresh", "account")
            .await
            .unwrap()
            .remove(0);
        let catalog = PluginCatalog::for_test(root.path().to_owned());
        let entry = catalog
            .entries(&executable)
            .await
            .pop()
            .expect("test plugin loads");
        let registry = PluginRegistry {
            inner: Arc::new(RegistryInner {
                store,
                state,
                catalog,
                runtime: PluginRuntime::for_test(),
                entries: Default::default(),
                workers: Default::default(),
                oauth_sessions: Default::default(),
                preparation_locks: Default::default(),
                pending_preparations: Default::default(),
                resource_operations: Default::default(),
                quota_summaries: Default::default(),
                rr_counter: Default::default(),
            }),
        };
        (root, registry, entry, executable, record)
    }

    async fn stop_workers(registry: &PluginRegistry) {
        for worker in registry.inner.workers.lock().await.values() {
            worker.stop().await;
        }
    }

    #[tokio::test]
    #[ignore = "requires DENO_TEST_EXECUTABLE"]
    async fn concurrent_requests_refresh_once_and_observe_committed_tokens() {
        let (_root, registry, entry, executable, record) = fixture().await;
        let mut tasks = Vec::new();
        for _ in 0..16 {
            let (registry, entry, executable, record) = (
                registry.clone(),
                entry.clone(),
                executable.clone(),
                record.clone(),
            );
            tasks.push(tokio::spawn(async move {
                registry
                    .prepare_resource(&entry, &executable, "account", record, None)
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            assert_eq!(
                task.await.unwrap().private_data["refreshToken"],
                "rotated-1"
            );
        }
        let stored = registry
            .inner
            .state
            .resources("dev.refresh", "account")
            .await
            .unwrap();
        assert_eq!(stored[0].private_data["refreshToken"], "rotated-1");
        stop_workers(&registry).await;
    }

    #[tokio::test]
    #[ignore = "requires DENO_TEST_EXECUTABLE"]
    async fn cancelled_model_request_still_commits_rotated_credentials() {
        let (_root, registry, entry, executable, record) = fixture().await;
        let key = format!("dev.refresh/account/{}", record.id);
        let copy = registry.clone();
        let task = tokio::spawn(async move {
            copy.prepare_resource(&entry, &executable, "account", record, None)
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if registry
                    .inner
                    .preparation_locks
                    .lock()
                    .await
                    .contains_key(&key)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let stored = registry
                    .inner
                    .state
                    .resources("dev.refresh", "account")
                    .await
                    .unwrap();
                if stored[0].private_data["refreshToken"] == "rotated-1" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        stop_workers(&registry).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires DENO_TEST_EXECUTABLE"]
    async fn failed_disk_write_retries_saved_rotation_without_reusing_old_token() {
        let (root, registry, entry, executable, record) = fixture().await;
        let path = root.path().join("data/dev.refresh/resources-account.json");
        let original = std::fs::metadata(&path).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&path, readonly).unwrap();
        let result = registry
            .prepare_resource(&entry, &executable, "account", record.clone(), None)
            .await;
        std::fs::set_permissions(&path, original).unwrap();
        assert!(result.is_err());
        assert_eq!(registry.inner.pending_preparations.lock().await.len(), 1);
        let prepared = registry
            .prepare_resource(&entry, &executable, "account", record, None)
            .await
            .unwrap();
        assert_eq!(prepared.private_data["refreshToken"], "rotated-1");
        assert!(registry.inner.pending_preparations.lock().await.is_empty());
        stop_workers(&registry).await;
    }
}
