//! Persists application settings.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::Result;

use super::{now_ms, Store};

const PORT_SETTINGS_KEY: &str = "network_ports";
const PROXY_SETTINGS_KEY: &str = "outbound_proxy";
const TAB_SETTINGS_KEY: &str = "cursor_tab";
const DESKTOP_SETTINGS_KEY: &str = "desktop_lifecycle";
const COMPACTION_SETTINGS_KEY: &str = "conversation_compaction";

pub const MIN_COMPACTION_RESERVE_TOKENS: u64 = 50_000;
pub const MAX_COMPACTION_RESERVE_TOKENS: u64 = 150_000;
pub const DEFAULT_COMPACTION_RESERVE_TOKENS: u64 = 100_000;
const COMMIT_SETTINGS_KEY: &str = "commit_settings";
const CURSOR_TAKEOVER_ENABLED_KEY: &str = "cursor_takeover_enabled";
const PRICING_SETTINGS_KEY: &str = "token_pricing";
const SUBAGENT_ROUTING_KEY: &str = "subagent_routing";
const DISABLED_PLUGIN_MODELS_KEY: &str = "disabled_plugin_models";
const DISABLED_PLUGIN_ACCOUNTS_KEY: &str = "disabled_plugin_accounts";
const PLUGIN_MODEL_OVERRIDES_KEY: &str = "plugin_model_overrides";

/// Embedded default system prompt for commit message generation.
pub const DEFAULT_COMMIT_PROMPT: &str = include_str!("../../prompt/cursor/commit/prompt.md");

pub const PUBLIC_TAB_SERVICE_URL: &str = "https://tab.leokun.cn";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct PortSettings {
    pub proxy_port: u16,
    pub service_port: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct TokenPricingSettings {
    pub input_per_million: f64,
    pub output_per_million: f64,
    pub cache_read_per_million: f64,
    pub cache_write_per_million: f64,
}

impl Default for TokenPricingSettings {
    fn default() -> Self {
        Self {
            input_per_million: 5.0,
            output_per_million: 25.0,
            cache_read_per_million: 0.5,
            cache_write_per_million: 6.25,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    #[default]
    Default,
    Custom,
}

impl ProxyMode {
    pub fn is_custom(self) -> bool {
        self == Self::Custom
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TabMode {
    #[default]
    Public,
    Direct,
    Custom,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct TabSettings {
    pub mode: TabMode,
    pub address: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct DesktopSettings {
    #[serde(default)]
    pub silent_start: bool,
    #[serde(default = "default_true")]
    pub show_dock_icon: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct CompactionSettings {
    pub reserve_tokens: u64,
}

impl Default for CompactionSettings {
    fn default() -> Self {
        Self {
            reserve_tokens: DEFAULT_COMPACTION_RESERVE_TOKENS,
        }
    }
}

impl CompactionSettings {
    fn validate(self) -> Result<Self> {
        if !(MIN_COMPACTION_RESERVE_TOKENS..=MAX_COMPACTION_RESERVE_TOKENS)
            .contains(&self.reserve_tokens)
        {
            return Err(crate::Error::Config(format!(
                "compaction reserve tokens must be between {MIN_COMPACTION_RESERVE_TOKENS} and {MAX_COMPACTION_RESERVE_TOKENS}"
            )));
        }
        Ok(self)
    }
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            silent_start: false,
            show_dock_icon: true,
        }
    }
}

fn default_true() -> bool {
    true
}

impl TabSettings {
    pub fn service_url(&self) -> Option<&str> {
        match self.mode {
            TabMode::Public => Some(PUBLIC_TAB_SERVICE_URL),
            TabMode::Direct => None,
            TabMode::Custom => Some(&self.address),
        }
    }
}

/// User preferences for Git commit message generation.
///
/// Empty `model_id` means pass-through: forward the original Cursor RPC
/// unchanged. A non-empty value is the stable identifier of a configured
/// built-in or plugin model, and the request is generated locally through
/// that model.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct CommitSettings {
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub prompt: String,
}

impl CommitSettings {
    pub fn is_direct(&self) -> bool {
        self.model_id.trim().is_empty()
    }

    pub fn effective_prompt(&self) -> &str {
        let trimmed = self.prompt.trim();
        if trimmed.is_empty() {
            DEFAULT_COMMIT_PROMPT.trim()
        } else {
            trimmed
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct SubagentRoutingSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub target_model_id: String,
    #[serde(default = "default_model_aliases")]
    pub model_aliases: std::collections::BTreeMap<String, String>,
    #[serde(default = "default_true")]
    pub apply_to_subagents: bool,
    #[serde(default)]
    pub apply_to_normal_chats: bool,
}

fn default_model_aliases() -> std::collections::BTreeMap<String, String> {
    let mut aliases = std::collections::BTreeMap::new();
    aliases.insert("composer-2.5-fast".into(), "".into());
    aliases.insert("composer-2.5".into(), "".into());
    aliases.insert("default".into(), "".into());
    aliases
}

impl Default for SubagentRoutingSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            target_model_id: String::new(),
            model_aliases: default_model_aliases(),
            apply_to_subagents: true,
            apply_to_normal_chats: false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
pub struct ProxySettingsInput {
    pub mode: ProxyMode,
    pub address: String,
    pub auth_enabled: bool,
    pub username: String,
    pub password: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ProxySettings {
    pub mode: ProxyMode,
    pub address: String,
    pub auth_enabled: bool,
    pub username: String,
    pub has_password: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct ProxySettingsSecret {
    pub mode: ProxyMode,
    pub address: String,
    pub auth_enabled: bool,
    pub username: String,
    pub password: String,
}

/// Reads the persisted outbound proxy row, falling back to "no proxy" when it
/// no longer parses.
///
/// `mode` is a closed enum whose stored wire value has already changed once, so
/// a row written by an older build can be unreadable by this one. Propagating
/// that error would be unrecoverable rather than merely noisy: every outbound
/// client is built from this value, and `set_proxy_settings` reads the row
/// before it writes, so the settings page could neither load nor replace the
/// row that broke it.
fn read_proxy_settings(value: &str) -> ProxySettingsSecret {
    serde_json::from_str(value).unwrap_or_else(|error| {
        tracing::warn!(%error, "ignoring unreadable outbound proxy settings");
        ProxySettingsSecret::default()
    })
}

/// A user's manual override for a single plugin model; empty/None fields restore the
/// plugin defaults.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginModelOverride {
    pub display_name: Option<String>,
    pub tooltip: Option<String>,
    pub effort_options: Option<Vec<String>>,
    pub context_options: Option<Vec<String>>,
    pub max_output_tokens: Option<u64>,
}

impl PluginModelOverride {
    /// Normalizes an override: trims whitespace and folds empty strings, empty arrays,
    /// and 0 into None; a fully-default result means "no override" and the store drops
    /// the entry.
    pub fn normalized(self) -> Self {
        let text = |value: Option<String>| {
            value
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let options = |values: Option<Vec<String>>| {
            values
                .map(|values| {
                    values
                        .into_iter()
                        .map(|value| value.trim().to_owned())
                        .filter(|value| !value.is_empty())
                        .collect::<Vec<_>>()
                })
                .filter(|values| !values.is_empty())
        };
        Self {
            display_name: text(self.display_name),
            tooltip: text(self.tooltip),
            effort_options: options(self.effort_options),
            context_options: options(self.context_options),
            max_output_tokens: self.max_output_tokens.filter(|tokens| *tokens > 0),
        }
    }
}

impl Store {
    pub(crate) async fn cursor_takeover_enabled(&self) -> Result<bool> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(CURSOR_TAKEOVER_ENABLED_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or(Ok(true))
    }

    pub(crate) async fn set_cursor_takeover_enabled(&self, enabled: bool) -> Result<()> {
        let value_json = serde_json::to_string(&enabled)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(CURSOR_TAKEOVER_ENABLED_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub(crate) async fn proxy_settings_secret(&self) -> Result<ProxySettingsSecret> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(PROXY_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        Ok(value
            .as_deref()
            .map_or_else(ProxySettingsSecret::default, read_proxy_settings))
    }

    pub async fn proxy_settings(&self) -> Result<ProxySettings> {
        let settings = self.proxy_settings_secret().await?;
        Ok(ProxySettings {
            mode: settings.mode,
            address: settings.address,
            auth_enabled: settings.auth_enabled,
            username: settings.username,
            has_password: !settings.password.is_empty(),
        })
    }

    pub async fn set_proxy_settings(&self, input: ProxySettingsInput) -> Result<ProxySettings> {
        let existing = self.proxy_settings_secret().await?;
        let address = input.address.trim().to_owned();
        if input.mode.is_custom() {
            let parsed = url::Url::parse(&address)
                .map_err(|error| crate::Error::Config(format!("invalid proxy address: {error}")))?;
            if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
                return Err(crate::Error::Config(
                    "proxy address must use http, https, socks5, or socks5h".into(),
                ));
            }
            reqwest::Proxy::all(&address)?;
        }
        let password = if input.auth_enabled {
            input
                .password
                .filter(|password| !password.is_empty())
                .unwrap_or(existing.password)
        } else {
            String::new()
        };
        let settings = ProxySettingsSecret {
            mode: input.mode,
            address,
            auth_enabled: input.auth_enabled,
            username: input.username.trim().to_owned(),
            password,
        };
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind(PROXY_SETTINGS_KEY)
            .bind(value_json)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        self.proxy_settings().await
    }

    pub async fn tab_settings(&self) -> Result<TabSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(TAB_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(TabSettings::default()))
    }

    pub async fn set_tab_settings(&self, mut settings: TabSettings) -> Result<TabSettings> {
        settings.address = settings.address.trim().trim_end_matches('/').to_owned();
        if settings.mode == TabMode::Custom {
            let parsed = url::Url::parse(&settings.address).map_err(|error| {
                crate::Error::Config(format!("invalid TAB service address: {error}"))
            })?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(crate::Error::Config(
                    "TAB service address must use http or https".into(),
                ));
            }
            if parsed.host_str().is_none()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err(crate::Error::Config(
                    "TAB service address must be a base URL without a query or fragment".into(),
                ));
            }
        }
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind(TAB_SETTINGS_KEY)
            .bind(value_json)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        Ok(settings)
    }

    pub async fn port_settings(&self) -> Result<PortSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(PORT_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(PortSettings::default()))
    }

    pub async fn set_port_settings(&self, settings: PortSettings) -> Result<()> {
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(PORT_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_service_port(&self, port: u16) -> Result<()> {
        let mut settings = self.port_settings().await?;
        settings.service_port = port;
        self.set_port_settings(settings).await
    }

    pub async fn set_proxy_port(&self, port: u16) -> Result<()> {
        let mut settings = self.port_settings().await?;
        settings.proxy_port = port;
        self.set_port_settings(settings).await
    }

    pub async fn desktop_settings(&self) -> Result<DesktopSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(DESKTOP_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(DesktopSettings::default()))
    }

    pub async fn set_desktop_settings(&self, settings: DesktopSettings) -> Result<()> {
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(DESKTOP_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn compaction_settings(&self) -> Result<CompactionSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(COMPACTION_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| {
                serde_json::from_str::<CompactionSettings>(&value).map_err(crate::Error::from)
            })
            .unwrap_or_else(|| Ok(CompactionSettings::default()))?
            .validate()
    }

    pub async fn set_compaction_settings(
        &self,
        settings: CompactionSettings,
    ) -> Result<CompactionSettings> {
        let settings = settings.validate()?;
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query("INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms")
            .bind(COMPACTION_SETTINGS_KEY)
            .bind(value_json)
            .bind(now_ms())
            .execute(&self.pool)
            .await?;
        Ok(settings)
    }

    pub async fn commit_settings(&self) -> Result<CommitSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(COMMIT_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(CommitSettings::default()))
    }

    pub async fn set_commit_settings(&self, settings: CommitSettings) -> Result<CommitSettings> {
        let settings = CommitSettings {
            model_id: settings.model_id.trim().to_owned(),
            prompt: settings.prompt.trim().to_owned(),
        };
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(COMMIT_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(settings)
    }

    pub async fn subagent_routing_settings(&self) -> Result<SubagentRoutingSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(SUBAGENT_ROUTING_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(SubagentRoutingSettings::default()))
    }

    pub async fn set_subagent_routing_settings(
        &self,
        settings: SubagentRoutingSettings,
    ) -> Result<SubagentRoutingSettings> {
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(SUBAGENT_ROUTING_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(settings)
    }

    /// Resolves a user-facing model query (plugin id, configured hash, display
    /// name, or model id) to the configured model hash used on the Cursor wire.
    pub async fn resolve_model_hash(&self, query: &str) -> Result<Option<String>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(None);
        }
        if query.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
            return Ok(Some(query.to_owned()));
        }
        if self.model(query).await?.is_some() {
            return Ok(Some(query.to_owned()));
        }
        let models = self.models().await?;
        for model in &models {
            if model.display_name.eq_ignore_ascii_case(query)
                || model.model_id.eq_ignore_ascii_case(query)
                || model.model_hash.eq_ignore_ascii_case(query)
            {
                return Ok(Some(model.model_hash.clone()));
            }
        }
        Ok(None)
    }

    pub async fn first_model_hash(&self) -> Result<Option<String>> {
        let models = self.models().await?;
        Ok(models.first().map(|model| model.model_hash.clone()))
    }

    pub async fn pricing_settings(&self) -> Result<TokenPricingSettings> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(PRICING_SETTINGS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(TokenPricingSettings::default()))
    }

    pub async fn set_pricing_settings(
        &self,
        settings: TokenPricingSettings,
    ) -> Result<TokenPricingSettings> {
        let value_json = serde_json::to_string(&settings)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(PRICING_SETTINGS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(settings)
    }

    pub async fn disabled_plugin_models(&self) -> Result<HashSet<String>> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(DISABLED_PLUGIN_MODELS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(HashSet::new()))
    }

    pub async fn set_disabled_plugin_models(&self, model_ids: &HashSet<String>) -> Result<()> {
        let value_json = serde_json::to_string(model_ids)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(DISABLED_PLUGIN_MODELS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn disabled_plugin_accounts(&self) -> Result<HashSet<String>> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(DISABLED_PLUGIN_ACCOUNTS_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(HashSet::new()))
    }

    pub async fn set_disabled_plugin_accounts(&self, account_ids: &HashSet<String>) -> Result<()> {
        let value_json = serde_json::to_string(account_ids)?;
        let _write = self.writes.lock().await;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(DISABLED_PLUGIN_ACCOUNTS_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn plugin_model_overrides(&self) -> Result<HashMap<String, PluginModelOverride>> {
        let value = sqlx::query_scalar::<_, String>(
            "SELECT value_json FROM service_settings WHERE setting_key = ?",
        )
        .bind(PLUGIN_MODEL_OVERRIDES_KEY)
        .fetch_optional(&self.pool)
        .await?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .unwrap_or_else(|| Ok(HashMap::new()))
    }

    /// The override is normalized before writing; a fully-empty value deletes the model's entry (restoring the plugin defaults).
    pub async fn set_plugin_model_override(
        &self,
        model_id: &str,
        over: PluginModelOverride,
    ) -> Result<()> {
        // The read-modify-write is fully serialized so concurrent saves cannot clobber each other.
        let _write = self.writes.lock().await;
        let mut overrides = self.plugin_model_overrides().await?;
        let over = over.normalized();
        if over == PluginModelOverride::default() {
            overrides.remove(model_id);
        } else {
            overrides.insert(model_id.to_owned(), over);
        }
        let value_json = serde_json::to_string(&overrides)?;
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .bind(PLUGIN_MODEL_OVERRIDES_KEY)
        .bind(value_json)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        read_proxy_settings, CommitSettings, PluginModelOverride, ProxyMode, ProxySettingsInput,
        ProxySettingsSecret, Store, TokenPricingSettings, DEFAULT_COMMIT_PROMPT,
        PROXY_SETTINGS_KEY,
    };

    /// The `outbound_proxy` row exactly as builds before the `system` -> `default`
    /// rename wrote it.
    const LEGACY_PROXY_ROW: &str =
        r#"{"mode":"system","address":"","auth_enabled":false,"username":"","password":""}"#;

    #[test]
    fn an_empty_commit_prompt_uses_the_default() {
        let settings = CommitSettings::default();
        assert_eq!(settings.effective_prompt(), DEFAULT_COMMIT_PROMPT.trim());
    }

    #[test]
    fn a_custom_commit_prompt_is_used_verbatim() {
        let settings = CommitSettings {
            prompt: "custom prompt".into(),
            ..CommitSettings::default()
        };
        assert_eq!(settings.effective_prompt(), "custom prompt");
    }


    #[test]
    fn default_proxy_mode_uses_the_default_wire_value() {
        assert_eq!(ProxyMode::default(), ProxyMode::Default);
        assert_eq!(
            serde_json::to_string(&ProxyMode::default()).unwrap(),
            "\"default\""
        );
        assert_eq!(
            serde_json::from_str::<ProxyMode>("\"default\"").unwrap(),
            ProxyMode::Default
        );
        assert!(serde_json::from_str::<ProxyMode>("\"system\"").is_err());
    }

    #[test]
    fn an_unreadable_proxy_row_reads_as_no_proxy() {
        assert!(serde_json::from_str::<ProxySettingsSecret>(LEGACY_PROXY_ROW).is_err());

        let settings = read_proxy_settings(LEGACY_PROXY_ROW);
        assert_eq!(settings.mode, ProxyMode::Default);
        assert!(settings.address.is_empty());
        assert!(!settings.auth_enabled);
    }

    #[tokio::test]
    async fn a_proxy_row_from_an_older_build_stays_replaceable() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();
        sqlx::query(
            "INSERT INTO service_settings(setting_key, value_json, updated_at_ms) VALUES (?, ?, 0)",
        )
        .bind(PROXY_SETTINGS_KEY)
        .bind(LEGACY_PROXY_ROW)
        .execute(store.pool())
        .await
        .unwrap();

        // Reading must not fail: every outbound client is built from this value.
        assert_eq!(
            store.proxy_settings().await.unwrap().mode,
            ProxyMode::Default
        );

        // And the settings page must be able to overwrite the row that broke it.
        let saved = store
            .set_proxy_settings(ProxySettingsInput {
                mode: ProxyMode::Custom,
                address: "http://127.0.0.1:7890".into(),
                auth_enabled: false,
                username: String::new(),
                password: None,
            })
            .await
            .unwrap();
        assert_eq!(saved.mode, ProxyMode::Custom);
        assert_eq!(saved.address, "http://127.0.0.1:7890");
    }

    #[tokio::test]
    async fn token_pricing_settings_persists_and_reads_back() {
        let directory = tempfile::tempdir().unwrap();
        let url = format!("sqlite://{}", directory.path().join("test.db").display());
        let store = Store::connect(&url).await.unwrap();

        assert_eq!(
            store.pricing_settings().await.unwrap(),
            TokenPricingSettings::default()
        );

        let custom = TokenPricingSettings {
            input_per_million: 3.0,
            output_per_million: 15.0,
            cache_read_per_million: 0.3,
            cache_write_per_million: 3.75,
        };
        let saved = store.set_pricing_settings(custom).await.unwrap();
        assert_eq!(saved, custom);

        assert_eq!(store.pricing_settings().await.unwrap(), custom);
    }

    #[tokio::test]
    async fn plugin_model_override_round_trips_and_drops_empty_entries() {
        let store = Store::connect("sqlite::memory:").await.unwrap();
        let model_id = "plugin:dev.example/codex/org/gpt-5";
        assert!(store.plugin_model_overrides().await.unwrap().is_empty());

        store
            .set_plugin_model_override(
                model_id,
                PluginModelOverride {
                    display_name: Some("  Kimi K2 ".into()),
                    tooltip: Some("   ".into()),
                    effort_options: Some(vec!["low".into(), " ".into()]),
                    context_options: Some(Vec::new()),
                    max_output_tokens: Some(0),
                },
            )
            .await
            .unwrap();
        let overrides = store.plugin_model_overrides().await.unwrap();
        assert_eq!(
            overrides.get(model_id),
            Some(&PluginModelOverride {
                display_name: Some("Kimi K2".into()),
                tooltip: None,
                effort_options: Some(vec!["low".into()]),
                context_options: None,
                max_output_tokens: None,
            })
        );

        store
            .set_plugin_model_override(model_id, PluginModelOverride::default())
            .await
            .unwrap();
        assert!(store.plugin_model_overrides().await.unwrap().is_empty());
    }
}
