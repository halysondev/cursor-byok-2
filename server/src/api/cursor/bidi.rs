//! Accepts ordered Cursor Bidi append requests and routes them by request_id.
use prost::Message;

use crate::{
    cursor::{
        conversation::TransportCommand,
        protocol::{
            events,
            proto::{agent::v1 as agent, aiserver::v1 as ai},
        },
        transport::{TransportParent, TransportRegistry},
    },
    Error, Result,
};

pub struct DecodedAppend {
    pub request_id: String,
    pub seqno: i64,
    pub message: agent::AgentClientMessage,
}

impl DecodedAppend {
    pub fn model_id(&self) -> Option<&str> {
        let agent::agent_client_message::Message::RunRequest(request) =
            self.message.message.as_ref()?
        else {
            return None;
        };
        request
            .requested_model
            .as_ref()
            .map(|model| model.model_id.as_str())
            .filter(|model| !model.is_empty())
            .or_else(|| {
                request
                    .model_details
                    .as_ref()
                    .map(|model| model.model_id.as_str())
                    .filter(|model| !model.is_empty())
            })
    }

    pub fn conversation_id(&self) -> Option<&str> {
        let agent::agent_client_message::Message::RunRequest(request) =
            self.message.message.as_ref()?
        else {
            return None;
        };
        request.conversation_id.as_deref()
    }

    /// Rewrites explicit Cursor model selections (requested model, model
    /// details, and subagent overrides) that match a configured alias onto the
    /// aliased BYOK model. Inheritance and request parameters are preserved.
    pub async fn resolve_model_aliases(&mut self, store: &crate::store::Store) -> Result<()> {
        let Some(agent::agent_client_message::Message::RunRequest(request)) =
            self.message.message.as_mut()
        else {
            return Ok(());
        };
        let aliases = store.cursor_model_aliases().await?;
        if aliases.is_empty() {
            return Ok(());
        }
        let mut selections = Vec::new();
        if let Some(model) = request.requested_model.as_mut() {
            selections.push(&mut model.model_id);
        }
        if let Some(model) = request.model_details.as_mut() {
            selections.push(&mut model.model_id);
        }
        for selection in &mut request.subagent_model_overrides {
            if let Some(agent::subagent_model_override::Selection::Model(model)) =
                selection.selection.as_mut()
            {
                selections.push(&mut model.model_id);
            }
        }
        for selection in selections {
            if let Some(target) = aliases.get(selection.as_str()) {
                // A deleted/reconfigured target must not silently send the request
                // (and its context) to the original hosted model instead.
                if store.model(target).await?.is_none() {
                    return Err(Error::Config(format!(
                        "Cursor model alias {selection} targets a missing BYOK model"
                    )));
                }
                selection.clone_from(target);
            }
        }
        Ok(())
    }

    /// Subagent routing interception. When enabled in the settings, hosted
    /// Cursor models (composer-2.5-fast / composer-2.5 / `default`, or any
    /// configured alias key) are rewritten onto a configured BYOK model —
    /// for subagent runs (identified by `subagent_type_name` or the parent
    /// headers), normal chats, or both, per the settings' scope. Parent
    /// requests also get their subagent model overrides rewritten/expanded
    /// so spawned subagents inherit the routing.
    pub async fn resolve_subagent_and_model_aliases(
        &mut self,
        store: &crate::store::Store,
        headers: &axum::http::HeaderMap,
    ) -> Result<()> {
        use agent::agent_client_message::Message as ClientMessage;
        use agent::subagent_model_override::Selection;

        let Some(ClientMessage::RunRequest(request)) = self.message.message.as_mut() else {
            return Ok(());
        };
        let settings = store.subagent_routing_settings().await?;
        if !settings.enabled {
            return Ok(());
        }

        let is_subagent =
            request.subagent_type_name.is_some() || headers.contains_key("x-parent-request-id");

        // Parent requests: rewrite existing subagent model overrides (only
        // when the scope includes subagents) so spawned subagents land on the
        // routed model instead of a hosted one.
        if !is_subagent && settings.apply_to_subagents {
            let target_hash = if !settings.target_model_id.trim().is_empty() {
                store.resolve_model_hash(&settings.target_model_id).await?
            } else {
                store.first_model_hash().await?
            };
            if let Some(target_hash) = target_hash {
                for selection in &mut request.subagent_model_overrides {
                    if let Some(Selection::Model(model)) = selection.selection.as_mut() {
                        if model.model_id == "composer-2.5-fast"
                            || model.model_id == "composer-2.5"
                            || model.model_id == "default"
                            || settings.model_aliases.contains_key(&model.model_id)
                        {
                            model.model_id.clone_from(&target_hash);
                        }
                    }
                }
                for subagent_type in ["generalPurpose", "explore"] {
                    if !request
                        .subagent_model_overrides
                        .iter()
                        .any(|override_entry| override_entry.subagent_type == subagent_type)
                    {
                        request
                            .subagent_model_overrides
                            .push(agent::SubagentModelOverride {
                                subagent_type: subagent_type.into(),
                                selection: Some(Selection::Model(agent::RequestedModel {
                                    model_id: target_hash.clone(),
                                    ..Default::default()
                                })),
                            });
                    }
                }
            }
        }

        // Whether THIS request qualifies for the rewrite per the scope.
        let qualifies_for_rewrite = if is_subagent {
            settings.apply_to_subagents
        } else {
            settings.apply_to_normal_chats
        };
        if !qualifies_for_rewrite {
            return Ok(());
        }

        let current_model = request
            .requested_model
            .as_ref()
            .map(|model| model.model_id.as_str())
            .or_else(|| {
                request
                    .model_details
                    .as_ref()
                    .map(|model| model.model_id.as_str())
            })
            .unwrap_or_default();

        let alias_key_hit = settings.model_aliases.contains_key(current_model);
        let target_hash = if let Some(alias_target) = settings
            .model_aliases
            .get(current_model)
            .filter(|target| !target.trim().is_empty())
        {
            store.resolve_model_hash(alias_target).await?
        } else if alias_key_hit {
            // An alias key matches but is blank: fall back to the configured
            // target or the first configured model.
            if !settings.target_model_id.trim().is_empty() {
                store.resolve_model_hash(&settings.target_model_id).await?
            } else {
                store.first_model_hash().await?
            }
        } else if is_subagent {
            if !settings.target_model_id.trim().is_empty() {
                store.resolve_model_hash(&settings.target_model_id).await?
            } else if store.model(current_model).await?.is_some() {
                // Already a valid configured model — keep it.
                None
            } else {
                store.first_model_hash().await?
            }
        } else {
            None
        };

        if let Some(target_hash) = target_hash {
            tracing::info!(
                request_id = self.request_id,
                original_model = current_model,
                target_model = %target_hash,
                is_subagent,
                subagent_type = ?request.subagent_type_name,
                "intercepted Cursor request and routed to BYOK model"
            );
            if let Some(model) = request.requested_model.as_mut() {
                model.model_id.clone_from(&target_hash);
            } else {
                request.requested_model = Some(agent::RequestedModel {
                    model_id: target_hash.clone(),
                    ..Default::default()
                });
            }
            if let Some(details) = request.model_details.as_mut() {
                details.model_id.clone_from(&target_hash);
            }
        }

        Ok(())
    }

    /// A first message with no model selection is Cursor asking the backend to
    /// apply the account default (the review agent does this). Resolve it the
    /// BYOK way: the subagent-routing target when configured, else the first
    /// configured model. Returns the injected model id, or None when the
    /// request already carries a selection or no model is configured.
    pub async fn ensure_default_model(
        &mut self,
        store: &crate::store::Store,
    ) -> Result<Option<String>> {
        let Some(agent::agent_client_message::Message::RunRequest(request)) =
            self.message.message.as_mut()
        else {
            return Ok(None);
        };
        let already_selected = request
            .requested_model
            .as_ref()
            .is_some_and(|model| !model.model_id.is_empty())
            || request
                .model_details
                .as_ref()
                .is_some_and(|model| !model.model_id.is_empty());
        if already_selected {
            return Ok(None);
        }
        let settings = store.subagent_routing_settings().await?;
        let target = if !settings.target_model_id.trim().is_empty() {
            store.resolve_model_hash(&settings.target_model_id).await?
        } else {
            store.first_model_hash().await?
        };
        let Some(target) = target else {
            return Ok(None);
        };
        request.requested_model = Some(agent::RequestedModel {
            model_id: target.clone(),
            ..Default::default()
        });
        if let Some(details) = request.model_details.as_mut() {
            details.model_id.clone_from(&target);
        }
        Ok(Some(target))
    }

    pub fn is_background_task_completion(&self) -> bool {
        let Some(agent::agent_client_message::Message::RunRequest(request)) =
            self.message.message.as_ref()
        else {
            return false;
        };
        matches!(
            request
                .action
                .as_ref()
                .and_then(|action| action.action.as_ref()),
            Some(agent::conversation_action::Action::BackgroundTaskCompletionAction(_))
        )
    }

    pub fn trace_metadata(&self) -> serde_json::Value {
        let Some(message) = self.message.message.as_ref() else {
            return serde_json::json!({
                "append_seqno": self.seqno,
                "message_type": "empty",
            });
        };
        let agent::agent_client_message::Message::RunRequest(request) = message else {
            return serde_json::json!({
                "append_seqno": self.seqno,
                "message_type": client_message_type(message),
            });
        };
        let (action_type, history_messages, history_images) = request
            .action
            .as_ref()
            .and_then(|action| action.action.as_ref())
            .map(|action| match action {
                agent::conversation_action::Action::UserMessageAction(action) => {
                    let history = action.conversation_history.as_ref();
                    (
                        "user_message",
                        history.map_or(0, |history| history.messages.len()),
                        history.map_or(0, history_image_count),
                    )
                }
                agent::conversation_action::Action::BackgroundTaskCompletionAction(_) => {
                    ("background_task_completion", 0, 0)
                }
                agent::conversation_action::Action::ExecutePlanAction(_) => ("execute_plan", 0, 0),
                agent::conversation_action::Action::SummarizeAction(_) => ("summarize", 0, 0),
                _ => ("other", 0, 0),
            })
            .unwrap_or(("none", 0, 0));
        let state = request.conversation_state.as_ref();
        serde_json::json!({
            "append_seqno": self.seqno,
            "message_type": "run_request",
            "conversation_id": request.conversation_id,
            "model_id": self.model_id(),
            "action_type": action_type,
            "conversation_history_messages": history_messages,
            "conversation_history_images": history_images,
            "root_message_count": state.map_or(0, |state| state.root_prompt_messages_json.len()),
            "turn_count": state.map_or(0, |state| state.turns.len()),
            "prefetched_blob_count": request.pre_fetched_blobs.len(),
        })
    }
}

fn client_message_type(message: &agent::agent_client_message::Message) -> &'static str {
    use agent::agent_client_message::Message;
    match message {
        Message::RunRequest(_) => "run_request",
        Message::ExecClientMessage(_) => "exec_client_message",
        Message::ExecClientControlMessage(_) => "exec_client_control_message",
        Message::KvClientMessage(_) => "kv_client_message",
        Message::ConversationAction(_) => "conversation_action",
        Message::InteractionResponse(_) => "interaction_response",
        Message::ClientHeartbeat(_) => "client_heartbeat",
        Message::PrewarmRequest(_) => "prewarm_request",
    }
}

fn history_image_count(history: &agent::ConversationHistory) -> usize {
    use agent::{
        conversation_history_message::Message,
        conversation_history_tool_result_content::Content as ToolContent,
        conversation_history_user_content::Content as UserContent,
    };
    history
        .messages
        .iter()
        .map(|message| match message.message.as_ref() {
            Some(Message::User(user)) => user
                .content
                .iter()
                .filter(|content| matches!(content.content, Some(UserContent::Image(_))))
                .count(),
            Some(Message::Tool(tool)) => tool
                .content
                .iter()
                .filter(|content| matches!(content.content, Some(ToolContent::Image(_))))
                .count(),
            _ => 0,
        })
        .sum()
}

pub fn decode(request: &ai::BidiAppendRequest) -> Result<DecodedAppend> {
    let request_id = request
        .request_id
        .as_ref()
        .map(|id| id.request_id.as_str())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Error::Protocol("BidiAppend request_id is required".into()))?;
    if !request.data_binary.is_empty() {
        return Err(Error::Protocol(
            "BidiAppend data_binary is not part of the captured protocol".into(),
        ));
    }
    if request.data.is_empty() {
        return Err(Error::Protocol(
            "BidiAppend contains no AgentClientMessage".into(),
        ));
    }
    let payload = hex::decode(&request.data)
        .map_err(|error| Error::Protocol(format!("invalid BidiAppend hex: {error}")))?;
    Ok(DecodedAppend {
        request_id: request_id.into(),
        seqno: request.append_seqno,
        message: agent::AgentClientMessage::decode(payload.as_slice())?,
    })
}

pub async fn append(
    registry: &TransportRegistry,
    request: DecodedAppend,
    parent: Option<TransportParent>,
) -> Result<ai::BidiAppendResponse> {
    let replace_closing = request.model_id().is_some();
    let handle = registry
        .get_or_create_for_append(&request.request_id, replace_closing)
        .await?;
    let _admission = handle.admit()?;
    if let Some(conversation_id) = request.conversation_id() {
        handle.set_conversation_id(conversation_id)?;
    }
    if let Some(parent) = parent {
        handle.set_parent(parent)?;
    }
    if matches!(
        request.message.message.as_ref(),
        Some(agent::agent_client_message::Message::ClientHeartbeat(_))
    ) {
        handle.emit(&events::heartbeat())?;
    }
    handle
        .command(TransportCommand::Append {
            seqno: request.seqno,
            message: Box::new(request.message),
        })
        .await?;
    Ok(ai::BidiAppendResponse {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelConfigInput, ModelType, OPENAI_CHAT_ENDPOINT};
    use crate::store::SubagentRoutingSettings;
    use axum::http::HeaderMap;

    async fn test_store_with_model() -> (tempfile::TempDir, crate::store::Store, String) {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = crate::store::Store::connect(&url).await.unwrap();
        let model = store
            .create_model(&ModelConfigInput {
                sort_order: 0,
                display_name: "deepseek-v4.1-flash free".into(),
                group_name: None,
                model_type: ModelType::OpenAi,
                base_url: "http://127.0.0.1:3000/v1".into(),
                use_full_url: false,
                api_key: "local".into(),
                tooltip_data: "deepseek-v4.1-flash free".into(),
                model_id: "deepseek-v4.1-flash".into(),
                reasoning_effort: None,
                openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
                openai_extra_params_enabled: false,
                openai_extra_params: serde_json::json!({}),
                custom_headers_enabled: false,
                custom_headers: serde_json::json!({}),
                anthropic_extra_params_enabled: false,
                anthropic_extra_params: serde_json::json!({}),
                context_window_tokens: None,
                max_completion_tokens: None,
                anthropic_max_tokens: None,
                anthropic_thinking_effort: None,
                thinking_budget_tokens: None,
            })
            .await
            .unwrap();
        let model_hash = model.model_hash.clone();
        (directory, store, model_hash)
    }

    fn run_request(model_id: &str) -> agent::AgentClientMessage {
        agent::AgentClientMessage {
            message: Some(agent::agent_client_message::Message::RunRequest(
                agent::AgentRunRequest {
                    requested_model: Some(agent::RequestedModel {
                        model_id: model_id.into(),
                        ..Default::default()
                    }),
                    model_details: Some(agent::ModelDetails {
                        model_id: model_id.into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
        }
    }

    #[tokio::test]
    async fn explore_subagent_intercepted_and_routed_to_byok_model() {
        let (_dir, store, expected_hash) = test_store_with_model().await;
        store
            .set_subagent_routing_settings(SubagentRoutingSettings {
                enabled: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let mut decoded = DecodedAppend {
            request_id: "test-req-1".into(),
            seqno: 1,
            message: agent::AgentClientMessage {
                message: Some(agent::agent_client_message::Message::RunRequest(
                    agent::AgentRunRequest {
                        subagent_type_name: Some("explore".into()),
                        requested_model: Some(agent::RequestedModel {
                            model_id: "composer-2.5-fast".into(),
                            ..Default::default()
                        }),
                        model_details: Some(agent::ModelDetails {
                            model_id: "composer-2.5-fast".into(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                )),
            },
        };

        let headers = HeaderMap::new();
        decoded
            .resolve_subagent_and_model_aliases(&store, &headers)
            .await
            .unwrap();

        assert_eq!(decoded.model_id(), Some(expected_hash.as_str()));
    }

    #[tokio::test]
    async fn model_less_run_defaults_to_first_configured_model() {
        let (_dir, store, expected_hash) = test_store_with_model().await;
        let mut decoded = DecodedAppend {
            request_id: "test-default-1".into(),
            seqno: 0,
            message: agent::AgentClientMessage {
                message: Some(agent::agent_client_message::Message::RunRequest(
                    agent::AgentRunRequest::default(),
                )),
            },
        };
        let injected = decoded.ensure_default_model(&store).await.unwrap();
        assert_eq!(injected.as_deref(), Some(expected_hash.as_str()));
        assert_eq!(decoded.model_id(), Some(expected_hash.as_str()));
    }

    #[tokio::test]
    async fn model_less_run_without_configured_models_stays_model_less() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = crate::store::Store::connect(&url).await.unwrap();
        let mut decoded = DecodedAppend {
            request_id: "test-default-2".into(),
            seqno: 0,
            message: agent::AgentClientMessage {
                message: Some(agent::agent_client_message::Message::RunRequest(
                    agent::AgentRunRequest::default(),
                )),
            },
        };
        let injected = decoded.ensure_default_model(&store).await.unwrap();
        assert_eq!(injected, None);
        assert_eq!(decoded.model_id(), None);
    }

    #[tokio::test]
    async fn subagent_header_intercepted_and_routed_to_byok_model() {
        let (_dir, store, expected_hash) = test_store_with_model().await;
        store
            .set_subagent_routing_settings(SubagentRoutingSettings {
                enabled: true,
                ..Default::default()
            })
            .await
            .unwrap();
        let mut decoded = DecodedAppend {
            request_id: "test-req-2".into(),
            seqno: 1,
            message: run_request("composer-2.5-fast"),
        };

        let mut headers = HeaderMap::new();
        headers.insert("x-parent-request-id", "parent-req-123".parse().unwrap());
        decoded
            .resolve_subagent_and_model_aliases(&store, &headers)
            .await
            .unwrap();

        assert_eq!(decoded.model_id(), Some(expected_hash.as_str()));
    }

    #[tokio::test]
    async fn model_alias_intercepted_for_regular_request() {
        let (_dir, store, expected_hash) = test_store_with_model().await;
        let settings = SubagentRoutingSettings {
            enabled: true,
            apply_to_normal_chats: true,
            model_aliases: SubagentRoutingSettings::default()
                .model_aliases
                .into_iter()
                .chain([("composer-2.5-fast".into(), expected_hash.clone())])
                .collect(),
            ..Default::default()
        };
        store.set_subagent_routing_settings(settings).await.unwrap();

        let mut decoded = DecodedAppend {
            request_id: "test-req-3".into(),
            seqno: 1,
            message: run_request("composer-2.5-fast"),
        };

        let headers = HeaderMap::new();
        decoded
            .resolve_subagent_and_model_aliases(&store, &headers)
            .await
            .unwrap();

        assert_eq!(decoded.model_id(), Some(expected_hash.as_str()));
    }

    #[tokio::test]
    async fn interception_disabled_keeps_hosted_model() {
        let (_dir, store, _hash) = test_store_with_model().await;
        // Default settings have enabled: false.
        let mut decoded = DecodedAppend {
            request_id: "test-req-4".into(),
            seqno: 1,
            message: run_request("composer-2.5-fast"),
        };

        let headers = HeaderMap::new();
        decoded
            .resolve_subagent_and_model_aliases(&store, &headers)
            .await
            .unwrap();

        assert_eq!(decoded.model_id(), Some("composer-2.5-fast"));
    }

    #[tokio::test]
    async fn blank_alias_key_falls_back_to_target_model() {
        let (_dir, store, expected_hash) = test_store_with_model().await;
        let settings = SubagentRoutingSettings {
            enabled: true,
            apply_to_normal_chats: true,
            target_model_id: expected_hash.clone(),
            ..Default::default()
        };
        // The default alias map carries composer-2.5-fast -> "" (blank).
        store.set_subagent_routing_settings(settings).await.unwrap();

        let mut decoded = DecodedAppend {
            request_id: "test-req-5".into(),
            seqno: 1,
            message: run_request("composer-2.5-fast"),
        };

        let headers = HeaderMap::new();
        decoded
            .resolve_subagent_and_model_aliases(&store, &headers)
            .await
            .unwrap();

        assert_eq!(decoded.model_id(), Some(expected_hash.as_str()));
    }
}

#[cfg(test)]
mod alias_tests {
    use super::*;

    #[tokio::test]
    async fn resolves_all_explicit_selections_but_preserves_inheritance_and_parameters() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let model = store
            .create_model(&crate::model::ModelConfigInput {
                sort_order: 0,
                display_name: "BYOK model".into(),
                group_name: None,
                model_type: crate::model::ModelType::OpenAi,
                base_url: "https://example.invalid".into(),
                use_full_url: false,
                api_key: "test".into(),
                tooltip_data: "test".into(),
                model_id: "provider-model".into(),
                reasoning_effort: None,
                openai_endpoint: crate::model::OPENAI_CHAT_ENDPOINT.into(),
                openai_extra_params_enabled: false,
                openai_extra_params: serde_json::json!({}),
                custom_headers_enabled: false,
                custom_headers: serde_json::json!({}),
                anthropic_extra_params_enabled: false,
                anthropic_extra_params: serde_json::json!({}),
                context_window_tokens: None,
                max_completion_tokens: None,
                anthropic_max_tokens: None,
                anthropic_thinking_effort: None,
                thinking_budget_tokens: None,
            })
            .await
            .unwrap();
        store
            .set_cursor_model_aliases(std::collections::BTreeMap::from([(
                "hosted-model".into(),
                model.model_hash.clone(),
            )]))
            .await
            .unwrap();
        let selection = agent::RequestedModel {
            model_id: "hosted-model".into(),
            parameters: vec![agent::requested_model::ModelParameterValue {
                id: "effort".into(),
                value: "high".into(),
            }],
            ..Default::default()
        };
        let mut decoded = DecodedAppend {
            request_id: "aliases".into(),
            seqno: 0,
            message: agent::AgentClientMessage {
                message: Some(agent::agent_client_message::Message::RunRequest(
                    agent::AgentRunRequest {
                        requested_model: Some(selection.clone()),
                        model_details: Some(agent::ModelDetails {
                            model_id: "hosted-model".into(),
                            ..Default::default()
                        }),
                        subagent_model_overrides: vec![
                            agent::SubagentModelOverride {
                                subagent_type: "generalPurpose".into(),
                                selection: Some(agent::subagent_model_override::Selection::Model(
                                    selection.clone(),
                                )),
                            },
                            agent::SubagentModelOverride {
                                subagent_type: "explore".into(),
                                selection: Some(
                                    agent::subagent_model_override::Selection::Inherit(true),
                                ),
                            },
                        ],
                        ..Default::default()
                    },
                )),
            },
        };
        decoded.resolve_model_aliases(&store).await.unwrap();
        let Some(agent::agent_client_message::Message::RunRequest(run)) = decoded.message.message
        else {
            unreachable!()
        };
        let requested = run.requested_model.unwrap();
        assert_eq!(requested.model_id, model.model_hash);
        assert_eq!(requested.parameters, selection.parameters);
        assert_eq!(run.model_details.unwrap().model_id, model.model_hash);
        let Some(agent::subagent_model_override::Selection::Model(child)) =
            &run.subagent_model_overrides[0].selection
        else {
            unreachable!()
        };
        assert_eq!(child.model_id, model.model_hash);
        assert_eq!(child.parameters, selection.parameters);
        assert_eq!(
            run.subagent_model_overrides[1].selection,
            Some(agent::subagent_model_override::Selection::Inherit(true))
        );
    }
}
