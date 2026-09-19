//! Implements settings management endpoints.
use crate::Result;
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::store::{
    CommitSettings, DesktopSettings, PortSettings, ProxySettings, ProxySettingsInput,
    StatisticsStorage, StatisticsStorageScope, SubagentRoutingSettings, TabSettings,
    TokenPricingSettings, DEFAULT_COMMIT_PROMPT,
};

use super::{ControlService, ObservabilitySettings};

pub async fn get(State(service): State<ControlService>) -> Result<Json<ObservabilitySettings>> {
    Ok(Json(service.observability().await?))
}

pub async fn update(
    State(service): State<ControlService>,
    Json(settings): Json<ObservabilitySettings>,
) -> Result<Json<ObservabilitySettings>> {
    Ok(Json(service.set_observability(settings).await?))
}

pub async fn get_ports(State(service): State<ControlService>) -> Result<Json<PortSettings>> {
    Ok(Json(service.ports().await?))
}

pub async fn update_ports(
    State(service): State<ControlService>,
    Json(settings): Json<PortSettings>,
) -> Result<Json<PortSettings>> {
    Ok(Json(service.set_ports(settings).await?))
}

pub async fn get_storage(State(service): State<ControlService>) -> Result<Json<StatisticsStorage>> {
    Ok(Json(service.statistics_storage().await?))
}

pub async fn clear_storage(
    State(service): State<ControlService>,
    input: Option<Json<ClearStorageInput>>,
) -> Result<Json<StatisticsStorage>> {
    let scope = input.map(|Json(input)| input.scope).unwrap_or_default();
    let storage = match scope {
        StatisticsStorageScope::Details => service.clear_statistics_storage().await?,
        StatisticsStorageScope::All => service.clear_all_statistics_storage().await?,
    };
    Ok(Json(storage))
}

#[derive(Deserialize)]
pub struct ClearStorageInput {
    #[serde(default)]
    pub scope: StatisticsStorageScope,
}

pub async fn get_proxy(State(service): State<ControlService>) -> Result<Json<ProxySettings>> {
    Ok(Json(service.proxy_settings().await?))
}

pub async fn update_proxy(
    State(service): State<ControlService>,
    Json(settings): Json<ProxySettingsInput>,
) -> Result<Json<ProxySettings>> {
    Ok(Json(service.set_proxy_settings(settings).await?))
}

pub async fn get_tab(State(service): State<ControlService>) -> Result<Json<TabSettings>> {
    Ok(Json(service.tab_settings().await?))
}

pub async fn get_model_aliases(
    State(service): State<ControlService>,
) -> Result<Json<std::collections::BTreeMap<String, String>>> {
    Ok(Json(service.cursor_model_aliases().await?))
}

pub async fn update_model_aliases(
    State(service): State<ControlService>,
    Json(aliases): Json<std::collections::BTreeMap<String, String>>,
) -> Result<Json<std::collections::BTreeMap<String, String>>> {
    Ok(Json(service.set_cursor_model_aliases(aliases).await?))
}

pub async fn update_tab(
    State(service): State<ControlService>,
    Json(settings): Json<TabSettings>,
) -> Result<Json<TabSettings>> {
    Ok(Json(service.set_tab_settings(settings).await?))
}

pub async fn get_desktop(State(service): State<ControlService>) -> Result<Json<DesktopSettings>> {
    Ok(Json(service.desktop_settings().await?))
}

pub async fn update_desktop(
    State(service): State<ControlService>,
    Json(settings): Json<DesktopSettings>,
) -> Result<Json<DesktopSettings>> {
    service.set_desktop_settings(settings).await?;
    get_desktop(State(service)).await
}

/// Settings view for commit message generation. Empty `model_id` means
/// pass-through (forward the original Cursor RPC). A non-empty value is a
/// configured built-in or plugin model identifier. Empty `prompt` means "use
/// the built-in default".
#[derive(Serialize)]
pub struct CommitSettingsView {
    pub model_id: String,
    pub prompt: String,
    pub default_prompt: &'static str,
}

impl CommitSettingsView {
    fn new(settings: CommitSettings) -> Self {
        Self {
            model_id: settings.model_id,
            prompt: settings.prompt,
            default_prompt: DEFAULT_COMMIT_PROMPT.trim(),
        }
    }
}

pub async fn get_commit(State(service): State<ControlService>) -> Result<Json<CommitSettingsView>> {
    let settings = service.commit_settings().await?;
    Ok(Json(CommitSettingsView::new(settings)))
}

pub async fn update_commit(
    State(service): State<ControlService>,
    Json(settings): Json<CommitSettings>,
) -> Result<Json<CommitSettingsView>> {
    let saved = service.set_commit_settings(settings).await?;
    Ok(Json(CommitSettingsView::new(saved)))
}

pub async fn get_pricing_settings(
    State(service): State<ControlService>,
) -> Result<Json<TokenPricingSettings>> {
    Ok(Json(service.pricing_settings().await?))
}

pub async fn update_pricing_settings(
    State(service): State<ControlService>,
    Json(settings): Json<TokenPricingSettings>,
) -> Result<Json<TokenPricingSettings>> {
    Ok(Json(service.set_pricing_settings(settings).await?))
}

pub async fn get_subagent_routing(
    State(service): State<ControlService>,
) -> Result<Json<SubagentRoutingSettings>> {
    Ok(Json(service.subagent_routing().await?))
}

pub async fn update_subagent_routing(
    State(service): State<ControlService>,
    Json(settings): Json<SubagentRoutingSettings>,
) -> Result<Json<SubagentRoutingSettings>> {
    Ok(Json(service.set_subagent_routing(settings).await?))
}
