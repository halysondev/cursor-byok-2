//! Defines serializable plugin capability definitions and desktop descriptors.
use serde::{Deserialize, Serialize};

use super::state::{ResourceRecord, ResourceState, StoredModel};

/// Capability summary emitted by collect.ts; contains nothing executable.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginModuleDefinition {
    pub providers: Vec<ProviderDefinition>,
    #[serde(default)]
    pub resources: Vec<ResourceDefinition>,
}

/// Display text provided by a plugin: a plain string or a locale → text map; the core passes it through verbatim for the frontend to resolve.
pub type LocalizedText = serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderDefinition {
    pub id: String,
    pub display_name: LocalizedText,
    #[serde(default)]
    pub description: LocalizedText,
    pub provider_type: String,
    #[serde(default)]
    pub resource_type: Option<String>,
    pub has_models: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDefinition {
    #[serde(rename = "type")]
    pub resource_type: String,
    pub display_name: LocalizedText,
    #[serde(default)]
    pub add: Vec<AddMethodDefinition>,
    #[serde(default)]
    pub import: Option<ImportDefinition>,
    #[serde(default)]
    pub actions: Vec<ResourceActionDefinition>,
    pub can_refresh: bool,
    pub can_remove: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceActionDefinition {
    pub id: String,
    pub display_name: LocalizedText,
    #[serde(default)]
    pub description: LocalizedText,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub destructive: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddMethodDefinition {
    #[serde(rename = "type")]
    pub method_type: String,
    pub id: String,
    pub display_name: LocalizedText,
    #[serde(default)]
    pub description: LocalizedText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback: Option<OAuthCallbackDefinition>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthCallbackDefinition {
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDefinition {
    pub display_name: LocalizedText,
    #[serde(default)]
    pub description: LocalizedText,
    pub accept: Vec<String>,
    pub multiple: bool,
}

pub const OAUTH2_ADD_METHOD: &str = "oauth2.0";
pub const OAUTH2_AUTHORIZATION_CODE_ADD_METHOD: &str = "oauth2.authorization-code";

/// The full plugin view as seen by the desktop.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    pub icon: String,
    pub providers: Vec<PluginProviderDescriptor>,
    pub resources: Vec<PluginResourceDescriptor>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProviderDescriptor {
    pub id: String,
    pub plugin_id: String,
    pub display_name: LocalizedText,
    pub description: LocalizedText,
    pub provider_type: String,
    pub resource_type: Option<String>,
    pub has_models: bool,
    /// Invocation requirements met: the model catalog is non-empty and at least one resource exists when required.
    pub configured: bool,
    pub models: Vec<PluginModelDescriptor>,
}

/// A plugin model Cursor can call directly.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginModelDescriptor {
    /// Stable model ID: `plugin:<plugin>/<provider>/<model>`.
    pub id: String,
    pub plugin_id: String,
    pub plugin_name: String,
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub icon: String,
    pub provider_type: String,
    pub max_output_tokens: Option<u64>,
    pub images: bool,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResourceDescriptor {
    #[serde(rename = "type")]
    pub resource_type: String,
    pub display_name: LocalizedText,
    pub add: Vec<AddMethodDefinition>,
    pub import: Option<ImportDefinition>,
    pub actions: Vec<ResourceActionDefinition>,
    pub can_refresh: bool,
    pub can_remove: bool,
    pub resources: Vec<PluginResourceView>,
}

/// External projection of a single resource; credentials stay in core storage and never enter this structure.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginResourceView {
    pub id: String,
    pub state: ResourceState,
    pub display_name: String,
    pub description: LocalizedText,
    pub metrics: Vec<ResourceMetric>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceMetric {
    pub id: String,
    pub label: LocalizedText,
    pub unit: String,
    pub value: f64,
    #[serde(default)]
    pub reset_at_ms: Option<i64>,
}

/// The plugin's display projection of a resource (the return value of resource.present).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePresentation {
    pub display_name: String,
    #[serde(default)]
    pub description: LocalizedText,
    #[serde(default)]
    pub metrics: Vec<ResourceMetric>,
}

/// Safe details returned by a plugin resource action; the patch is only applied inside the core and never sent back to the desktop.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceActionResult {
    pub title: LocalizedText,
    #[serde(default)]
    pub description: Option<LocalizedText>,
    #[serde(default)]
    pub cards: Vec<ResourceActionCard>,
    #[serde(default, skip_serializing)]
    pub patch: Option<super::state::ResourcePatch>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceActionCard {
    pub id: String,
    pub title: LocalizedText,
    #[serde(default)]
    pub status: Option<LocalizedText>,
    #[serde(default)]
    pub granted_at_ms: Option<i64>,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
    #[serde(default)]
    pub fields: Vec<ResourceActionField>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceActionField {
    pub id: String,
    pub label: LocalizedText,
    pub value: String,
}

/// Resource action result returned to the desktop, explicitly excluding the plugin-private patch.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceActionResponse {
    pub title: LocalizedText,
    pub description: Option<LocalizedText>,
    pub cards: Vec<ResourceActionCard>,
}

impl From<ResourceActionResult> for ResourceActionResponse {
    fn from(result: ResourceActionResult) -> Self {
        Self {
            title: result.title,
            description: result.description,
            cards: result.cards,
        }
    }
}

impl PluginResourceView {
    pub fn from_record(record: &ResourceRecord, presentation: ResourcePresentation) -> Self {
        Self {
            id: record.id.clone(),
            state: record.state.clone(),
            display_name: presentation.display_name,
            description: presentation.description,
            metrics: presentation.metrics,
            created_at_ms: record.created_at_ms,
        }
    }
}

pub const ADAPTER_ID_PREFIX: &str = "plugin:";

pub fn model_id(plugin_id: &str, provider_id: &str, model_id: &str) -> String {
    format!("{ADAPTER_ID_PREFIX}{plugin_id}/{provider_id}/{model_id}")
}

/// Parses a stable model ID; the upstream model segment may contain `/`.
pub fn parse_model_id(value: &str) -> Option<(&str, &str, &str)> {
    let rest = value.strip_prefix(ADAPTER_ID_PREFIX)?;
    let (plugin_id, rest) = rest.split_once('/')?;
    let (provider_id, model_id) = rest.split_once('/')?;
    (!plugin_id.is_empty() && !provider_id.is_empty() && !model_id.is_empty()).then_some((
        plugin_id,
        provider_id,
        model_id,
    ))
}

impl PluginModelDescriptor {
    pub fn new(
        plugin_id: &str,
        plugin_name: &str,
        icon: &str,
        provider: &ProviderDefinition,
        model: &StoredModel,
    ) -> Self {
        Self {
            id: model_id(plugin_id, &provider.id, &model.id),
            plugin_id: plugin_id.to_owned(),
            plugin_name: plugin_name.to_owned(),
            provider_id: provider.id.clone(),
            model_id: model.id.clone(),
            display_name: model.display_name.clone(),
            description: model.description.clone(),
            icon: icon.to_owned(),
            provider_type: provider.provider_type.clone(),
            max_output_tokens: model.max_output_tokens,
            images: model.images,
            enabled: model.enabled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stable_model_ids_with_slashes() {
        let id = model_id("dev.example", "codex", "org/gpt-5");
        assert_eq!(
            parse_model_id(&id),
            Some(("dev.example", "codex", "org/gpt-5"))
        );
        assert_eq!(parse_model_id("plugin:only/one"), None);
        assert_eq!(parse_model_id("model-hash"), None);
    }
}
