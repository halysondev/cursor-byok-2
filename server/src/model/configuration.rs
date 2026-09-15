//! Defines model and provider configuration.
use std::{fmt, str::FromStr};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

pub const OPENAI_RESPONSES_ENDPOINT: &str = "/v1/responses";
pub const OPENAI_CHAT_ENDPOINT: &str = "/v1/chat/completions";

/// The default Context tier shared by the Cursor catalog and the Task tool.
pub const DEFAULT_CONTEXT_OPTION: &str = "200k";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ProviderType {
    #[serde(rename = "openai-chat")]
    OpenAiChat,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic")]
    Anthropic,
    /// A call executed by a plugin; the protocol details live inside the plugin and the core only records the unified event stream.
    #[serde(rename = "plugin")]
    Plugin,
}

impl ProviderType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai-chat",
            Self::OpenAiResponses => "openai-responses",
            Self::Anthropic => "anthropic",
            Self::Plugin => "plugin",
        }
    }
}

impl fmt::Display for ProviderType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for ProviderType {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "openai-chat" => Ok(Self::OpenAiChat),
            "openai-responses" => Ok(Self::OpenAiResponses),
            "anthropic" => Ok(Self::Anthropic),
            "plugin" => Ok(Self::Plugin),
            _ => Err(Error::Config(format!("unsupported provider type: {value}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelType {
    OpenAi,
    Anthropic,
}

impl ModelType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}

impl FromStr for ModelType {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            _ => Err(Error::Config(format!("unsupported model type: {value}"))),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelConfigInput {
    #[serde(default)]
    pub sort_order: i64,
    pub display_name: String,
    /// Custom display name for a provider group; shared by all models under the same base_url host.
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(rename = "type")]
    pub model_type: ModelType,
    pub base_url: String,
    #[serde(default)]
    pub use_full_url: bool,
    pub api_key: String,
    pub tooltip_data: String,
    pub model_id: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default = "default_effort_options")]
    pub effort_options: Vec<String>,
    #[serde(default = "default_context_options")]
    pub context_options: Vec<String>,
    #[serde(default)]
    pub openai_endpoint: String,
    #[serde(default)]
    pub openai_extra_params_enabled: bool,
    #[serde(default = "empty_object")]
    pub openai_extra_params: serde_json::Value,
    #[serde(default)]
    pub custom_headers_enabled: bool,
    #[serde(default = "empty_object")]
    pub custom_headers: serde_json::Value,
    #[serde(default)]
    pub anthropic_extra_params_enabled: bool,
    #[serde(default = "empty_object")]
    pub anthropic_extra_params: serde_json::Value,
    pub context_window_tokens: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub anthropic_max_tokens: Option<u64>,
    #[serde(default)]
    pub anthropic_thinking_effort: Option<String>,
    pub thinking_budget_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelConfig {
    pub model_hash: String,
    pub sort_order: i64,
    pub display_name: String,
    pub group_name: Option<String>,
    /// Whether the model is published to Cursor's model catalog: the group
    /// switch toggles this flag in bulk; it does not affect the identity hash.
    pub enabled: bool,
    #[serde(rename = "type")]
    pub model_type: ModelType,
    pub base_url: String,
    pub use_full_url: bool,
    pub api_key: String,
    pub tooltip_data: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub effort_options: Vec<String>,
    pub context_options: Vec<String>,
    pub openai_endpoint: String,
    pub openai_extra_params_enabled: bool,
    pub openai_extra_params: serde_json::Value,
    pub custom_headers_enabled: bool,
    pub custom_headers: serde_json::Value,
    pub anthropic_extra_params_enabled: bool,
    pub anthropic_extra_params: serde_json::Value,
    pub context_window_tokens: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub anthropic_max_tokens: Option<u64>,
    pub anthropic_thinking_effort: Option<String>,
    pub thinking_budget_tokens: Option<u64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ModelConfig {
    pub fn provider_type(&self) -> ProviderType {
        match self.model_type {
            ModelType::Anthropic => ProviderType::Anthropic,
            ModelType::OpenAi if self.openai_endpoint == OPENAI_RESPONSES_ENDPOINT => {
                ProviderType::OpenAiResponses
            }
            ModelType::OpenAi => ProviderType::OpenAiChat,
        }
    }

    pub fn request_url(&self) -> Result<String> {
        resolve_request_url(
            self.model_type,
            &self.base_url,
            &self.openai_endpoint,
            self.use_full_url,
        )
    }

    pub fn max_output_tokens(&self) -> Option<u64> {
        match self.model_type {
            ModelType::OpenAi => self.max_completion_tokens,
            ModelType::Anthropic => self.anthropic_max_tokens.or(self.max_completion_tokens),
        }
    }

    pub fn extra_params(&self) -> &serde_json::Value {
        match self.model_type {
            ModelType::OpenAi if self.openai_extra_params_enabled => &self.openai_extra_params,
            ModelType::Anthropic if self.anthropic_extra_params_enabled => {
                &self.anthropic_extra_params
            }
            _ => empty_object_ref(),
        }
    }

    pub fn configure(&self, model: &mut super::ModelSpec) {
        model.display_name = Some(self.display_name.clone());
        // A configured context window has priority over the Cursor selection:
        // the custom option is the operator's explicit statement about the
        // upstream model, so it wins over whatever context tier Cursor picked.
        model.context_window_tokens = self.context_window_tokens.or(model.context_window_tokens);
        if model.max_output_tokens.is_none() {
            model.max_output_tokens = self.max_output_tokens();
        }
        if model.reasoning.explicitly_disabled {
            model.reasoning.enabled = false;
            model.reasoning.effort = None;
            return;
        }
        if model.reasoning.effort.is_none() {
            model.reasoning.effort = match self.model_type {
                ModelType::OpenAi => self.reasoning_effort.clone(),
                ModelType::Anthropic => self.anthropic_thinking_effort.clone(),
            };
        }
        model.reasoning.enabled |= model.reasoning.effort.is_some();
    }

    /// The same variant axis as the catalog: the named entry matching the configured
    /// window (or the bare token count) leads the context axis, the rest keep their
    /// configured order; the effort axis adopts the configuration as-is (it may be
    /// empty, meaning no reasoning axis).
    pub fn variant_axis(&self) -> ModelVariantAxis {
        let mut context_options = Vec::with_capacity(
            self.context_options.len() + usize::from(self.context_window_tokens.is_some()),
        );
        if let Some(tokens) = self.context_window_tokens {
            match self
                .context_options
                .iter()
                .find(|value| super::parse_token_count(value) == Some(tokens))
            {
                Some(value) => context_options.push(value.clone()),
                None => context_options.push(tokens.to_string()),
            }
        }
        for value in &self.context_options {
            if self
                .context_window_tokens
                .is_some_and(|tokens| super::parse_token_count(value) == Some(tokens))
            {
                continue;
            }
            context_options.push(value.clone());
        }
        ModelVariantAxis {
            context_options,
            effort_options: self.effort_options.clone(),
        }
    }
}

/// The components of a variant slug: {hash}-{context}[-{effort}][-fast];
/// a model without a reasoning axis has no effort segment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelVariantParts {
    pub context: String,
    pub effort: Option<String>,
    pub fast: bool,
}

/// One model's variant axes. Catalog publishing, slug parsing, and Task tool defaults share this single definition.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelVariantAxis {
    pub context_options: Vec<String>,
    pub effort_options: Vec<String>,
}

impl ModelVariantAxis {
    /// The catalog's default variant rule: context prefers 200k, otherwise the first
    /// entry; effort prefers high, otherwise the first entry, or None when there is
    /// no reasoning axis. Without a context axis the whole result is None (no slug
    /// can be baked).
    pub fn default_parts(&self) -> Option<ModelVariantParts> {
        let context = self
            .context_options
            .iter()
            .find(|value| value.as_str() == DEFAULT_CONTEXT_OPTION)
            .or_else(|| self.context_options.first())?
            .clone();
        let effort = if self.effort_options.is_empty() {
            None
        } else {
            Some(
                self.effort_options
                    .iter()
                    .find(|value| value.as_str() == "high")
                    .or_else(|| self.effort_options.first())
                    .expect("effort options are not empty")
                    .clone(),
            )
        };
        Some(ModelVariantParts {
            context,
            effort,
            fast: false,
        })
    }

    /// Parses a variant reference: both the hyphen slug {hash}-{context}[-{effort}][-fast]
    /// and the catalog's bracket notation {hash}[context=..,reasoning=..,fast=..]
    /// are accepted and validated identically.
    pub fn parse_slug(&self, hash: &str, key: &str) -> Option<ModelVariantParts> {
        if let Some(body) = key
            .strip_prefix(hash)
            .and_then(|rest| rest.strip_prefix('['))
            .and_then(|rest| rest.strip_suffix(']'))
        {
            return self.parse_variant_body(body);
        }
        let suffix = key.strip_prefix(&format!("{hash}-"))?;
        let (suffix, fast) = match suffix.strip_suffix("-fast") {
            Some(suffix) => (suffix, true),
            None => (suffix, false),
        };
        let (context, effort) = if self.effort_options.is_empty() {
            (suffix, None)
        } else {
            let (context, effort) = suffix.rsplit_once('-')?;
            (context, Some(effort))
        };
        if !self.accepts_context(context) {
            return None;
        }
        if let Some(effort) = effort {
            if !self.accepts_effort(effort) {
                return None;
            }
        }
        Some(ModelVariantParts {
            context: context.into(),
            effort: effort.map(str::to_string),
            fast,
        })
    }

    /// The bracket body is comma-separated id=value pairs; context is required,
    /// unknown ids are ignored.
    fn parse_variant_body(&self, body: &str) -> Option<ModelVariantParts> {
        let mut context = None;
        let mut effort = None;
        let mut fast = false;
        for pair in body.split(',') {
            let (id, value) = pair.split_once('=')?;
            match id {
                "context" => context = Some(value),
                "reasoning" | "effort" => effort = Some(value),
                "fast" => fast = value == "true",
                _ => {}
            }
        }
        let context = context?;
        if !self.accepts_context(context) {
            return None;
        }
        if let Some(effort) = effort {
            if !self.accepts_effort(effort) {
                return None;
            }
        }
        Some(ModelVariantParts {
            context: context.into(),
            effort: effort.map(str::to_string),
            fast,
        })
    }

    fn accepts_context(&self, context: &str) -> bool {
        self.context_options.iter().any(|value| value == context)
            || (context.bytes().all(|byte| byte.is_ascii_digit())
                && context.parse::<u64>().is_ok_and(|tokens| tokens > 0))
    }

    fn accepts_effort(&self, effort: &str) -> bool {
        !self.effort_options.is_empty()
            && (self.effort_options.iter().any(|value| value == effort)
                || matches!(effort, "none" | "off"))
    }

    /// Bakes a variant slug; without a reasoning axis it has no effort segment.
    pub fn bake_slug(&self, hash: &str, parts: &ModelVariantParts) -> String {
        let mut slug = format!("{hash}-{}", parts.context);
        if !self.effort_options.is_empty() {
            if let Some(effort) = &parts.effort {
                slug = format!("{slug}-{effort}");
            }
        }
        if parts.fast {
            slug = format!("{slug}-fast");
        }
        slug
    }

    /// The context option for a window token count; falls back to the bare token count when no named entry matches.
    pub fn context_option_for_tokens(&self, tokens: u64) -> Option<String> {
        Some(
            self.context_options
                .iter()
                .find(|value| super::parse_token_count(value) == Some(tokens))
                .cloned()
                .unwrap_or_else(|| tokens.to_string()),
        )
    }

    /// Validates a Task tool context parameter: after lowercasing it must land on the axis (an equal token count is allowed).
    pub fn validate_context(&self, value: &str) -> Result<String> {
        let value = value.trim().to_ascii_lowercase();
        if self.context_options.is_empty() {
            return Err(Error::Protocol(
                "Task model parameter context is not supported by this model".into(),
            ));
        }
        self.context_options
            .iter()
            .find(|option| option.as_str() == value)
            .or_else(|| {
                let tokens = super::parse_token_count(&value)?;
                self.context_options
                    .iter()
                    .find(|option| super::parse_token_count(option) == Some(tokens))
            })
            .cloned()
            .ok_or_else(|| {
                Error::Protocol(format!(
                    "Task model parameter context must be one of: {}",
                    self.context_options.join(", ")
                ))
            })
    }

    /// Validates a Task tool reasoning parameter: after lowercasing it must land on the axis.
    pub fn validate_effort(&self, value: &str) -> Result<String> {
        let value = value.trim().to_ascii_lowercase();
        if self.effort_options.is_empty() {
            return Err(Error::Protocol(
                "Task model parameter reasoning is not supported by this model".into(),
            ));
        }
        if self.effort_options.iter().any(|option| option == &value) {
            Ok(value)
        } else {
            Err(Error::Protocol(format!(
                "Task model parameter reasoning must be one of: {}",
                self.effort_options.join(", ")
            )))
        }
    }
}

pub fn normalize_model_input(input: &ModelConfigInput) -> Result<ModelConfigInput> {
    let display_name = required(&input.display_name, "model display name")?;
    let group_name = input
        .group_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from);
    let base_url = normalize_request_url(&input.base_url)?;
    let api_key = required(&input.api_key, "model API key")?;
    let tooltip_data = required(&input.tooltip_data, "model tooltip")?;
    let model_id = required(&input.model_id, "model id")?;
    let reasoning_effort = normalize_effort(input.reasoning_effort.as_deref(), true)?;
    let anthropic_thinking_effort = match input.model_type {
        ModelType::Anthropic => Some(
            normalize_effort(
                input.anthropic_thinking_effort.as_deref().or(Some("xhigh")),
                false,
            )?
            .expect("Anthropic effort has a default"),
        ),
        ModelType::OpenAi => None,
    };
    let openai_endpoint = match input.model_type {
        ModelType::OpenAi => normalize_openai_endpoint(&input.openai_endpoint)?,
        ModelType::Anthropic => String::new(),
    };
    validate_object(&input.openai_extra_params, "OpenAI extra params")?;
    validate_object(&input.anthropic_extra_params, "Anthropic extra params")?;
    validate_headers(&input.custom_headers)?;

    let normalized = ModelConfigInput {
        sort_order: input.sort_order.max(0),
        display_name,
        group_name,
        model_type: input.model_type,
        base_url,
        use_full_url: input.use_full_url,
        api_key,
        tooltip_data,
        model_id,
        reasoning_effort: (input.model_type == ModelType::OpenAi)
            .then_some(reasoning_effort)
            .flatten(),
        effort_options: input
            .effort_options
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .collect(),
        context_options: input.context_options.clone(),
        openai_endpoint,
        openai_extra_params_enabled: input.model_type == ModelType::OpenAi
            && input.openai_extra_params_enabled,
        openai_extra_params: if input.model_type == ModelType::OpenAi {
            input.openai_extra_params.clone()
        } else {
            empty_object()
        },
        custom_headers_enabled: input.custom_headers_enabled,
        custom_headers: input.custom_headers.clone(),
        anthropic_extra_params_enabled: input.model_type == ModelType::Anthropic
            && input.anthropic_extra_params_enabled,
        anthropic_extra_params: if input.model_type == ModelType::Anthropic {
            input.anthropic_extra_params.clone()
        } else {
            empty_object()
        },
        context_window_tokens: positive(input.context_window_tokens, "context window")?,
        max_completion_tokens: positive(input.max_completion_tokens, "max completion tokens")?,
        anthropic_max_tokens: positive(input.anthropic_max_tokens, "Anthropic max tokens")?,
        anthropic_thinking_effort,
        thinking_budget_tokens: positive(input.thinking_budget_tokens, "thinking budget")?,
    };
    resolve_request_url(
        normalized.model_type,
        &normalized.base_url,
        &normalized.openai_endpoint,
        normalized.use_full_url,
    )?;
    Ok(normalized)
}

pub fn model_hash(input: &ModelConfigInput) -> Result<String> {
    let normalized = normalize_model_input(input)?;
    let request_url = resolve_request_url(
        normalized.model_type,
        &normalized.base_url,
        &normalized.openai_endpoint,
        normalized.use_full_url,
    )?;
    let mut parts = vec![
        request_url,
        normalized.model_id,
        normalized.api_key,
        normalized.display_name,
    ];
    if normalized.model_type == ModelType::OpenAi {
        parts.push(normalized.openai_endpoint);
    }
    let digest = Sha256::digest(parts.join("\n").as_bytes());
    Ok(hex::encode(&digest[..8]))
}

pub fn normalize_request_url(value: &str) -> Result<String> {
    let value = value.trim();
    let url = Url::parse(value)
        .map_err(|error| Error::Config(format!("invalid model request URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::Config(
            "model request URL must be an HTTP(S) URL with a host".into(),
        ));
    }
    if url.fragment().is_some() {
        return Err(Error::Config(
            "model request URL cannot contain a fragment".into(),
        ));
    }
    Ok(value.into())
}

pub fn resolve_request_url(
    model_type: ModelType,
    base_url: &str,
    openai_endpoint: &str,
    use_full_url: bool,
) -> Result<String> {
    let base_url = normalize_request_url(base_url)?;
    let endpoint = match model_type {
        ModelType::OpenAi => normalize_openai_endpoint(openai_endpoint)?,
        ModelType::Anthropic => "/v1/messages".into(),
    };
    if use_full_url {
        return Ok(base_url);
    }
    append_standard_endpoint(&base_url, &endpoint)
}

fn append_standard_endpoint(base_url: &str, endpoint: &str) -> Result<String> {
    let mut url = Url::parse(base_url)
        .map_err(|error| Error::Config(format!("invalid model server URL: {error}")))?;
    let base_path = url.path().trim_end_matches('/').to_string();
    let endpoint = if has_trailing_version(&base_path) {
        endpoint.strip_prefix("/v1").unwrap_or(endpoint)
    } else {
        endpoint
    };
    url.set_path(&format!("{base_path}{endpoint}"));
    normalize_request_url(url.as_str())
}

fn has_trailing_version(path: &str) -> bool {
    let Some(segment) = path.rsplit('/').next() else {
        return false;
    };
    segment.strip_prefix('v').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub fn is_sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "x-api-key" | "api-key" | "cookie" | "set-cookie"
    )
}

fn normalize_openai_endpoint(value: &str) -> Result<String> {
    match value.trim() {
        "" | OPENAI_RESPONSES_ENDPOINT => Ok(OPENAI_RESPONSES_ENDPOINT.into()),
        OPENAI_CHAT_ENDPOINT => Ok(OPENAI_CHAT_ENDPOINT.into()),
        value => Err(Error::Config(format!(
            "unsupported OpenAI endpoint: {value}"
        ))),
    }
}

fn normalize_effort(value: Option<&str>, allow_empty: bool) -> Result<Option<String>> {
    let value = value.unwrap_or_default().trim().to_ascii_lowercase();
    if value.is_empty() && allow_empty {
        return Ok(None);
    }
    if matches!(value.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
        Ok(Some(value))
    } else {
        Err(Error::Config(format!(
            "unsupported reasoning effort: {value}"
        )))
    }
}

fn positive(value: Option<u64>, label: &str) -> Result<Option<u64>> {
    match value {
        Some(0) => Err(Error::Config(format!("{label} must be greater than zero"))),
        value => Ok(value),
    }
}

fn required(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        Err(Error::Config(format!("{label} cannot be empty")))
    } else {
        Ok(value.into())
    }
}

fn validate_object(value: &serde_json::Value, label: &str) -> Result<()> {
    if value.is_object() {
        Ok(())
    } else {
        Err(Error::Config(format!("{label} must be a JSON object")))
    }
}

fn validate_headers(value: &serde_json::Value) -> Result<()> {
    validate_object(value, "custom headers")?;
    for (name, value) in value.as_object().expect("validated object") {
        if name.trim().is_empty() || !value.is_string() {
            return Err(Error::Config(
                "custom headers must have non-empty names and string values".into(),
            ));
        }
    }
    Ok(())
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

pub const DEFAULT_EFFORT_OPTIONS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
pub const DEFAULT_CONTEXT_OPTIONS: &[&str] = &["200k", "356k", "800k", "1m"];

fn default_effort_options() -> Vec<String> {
    DEFAULT_EFFORT_OPTIONS
        .iter()
        .map(|value| (*value).into())
        .collect()
}

fn default_context_options() -> Vec<String> {
    DEFAULT_CONTEXT_OPTIONS
        .iter()
        .map(|value| (*value).into())
        .collect()
}

fn empty_object_ref() -> &'static serde_json::Value {
    static EMPTY: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    EMPTY.get_or_init(empty_object)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReasoningSpec {
    pub enabled: bool,
    pub effort: Option<String>,
    #[serde(default)]
    pub explicitly_disabled: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelLatency {
    #[default]
    Standard,
    Fast,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ModelSpec {
    pub model_id: String,
    pub display_name: Option<String>,
    pub reasoning: ReasoningSpec,
    pub latency: ModelLatency,
    pub max_output_tokens: Option<u64>,
    pub context_window_tokens: Option<u64>,
    #[serde(default)]
    pub supports_image_generation: bool,
    #[serde(default)]
    pub extra_params: serde_json::Value,
}

impl ModelSpec {
    pub fn new(model_id: impl Into<String>) -> Self {
        Self {
            model_id: model_id.into(),
            display_name: None,
            reasoning: ReasoningSpec::default(),
            latency: ModelLatency::Standard,
            max_output_tokens: None,
            context_window_tokens: None,
            supports_image_generation: false,
            extra_params: serde_json::json!({}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_context_window_has_priority_over_cursor_selection() {
        let provider = ModelConfig {
            model_hash: "12345678".into(),
            sort_order: 0,
            display_name: "Test".into(),
            group_name: None,
            enabled: true,
            model_type: ModelType::OpenAi,
            base_url: "https://provider.example/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "provider-secret".into(),
            tooltip_data: "Test".into(),
            model_id: "upstream-model".into(),
            reasoning_effort: None,
            effort_options: Vec::new(),
            context_options: Vec::new(),
            openai_endpoint: OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: Some(200_000),
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        };

        let mut selected = super::ModelSpec::new("12345678");
        selected.context_window_tokens = Some(800_000);
        provider.configure(&mut selected);
        assert_eq!(selected.context_window_tokens, Some(200_000));

        let mut defaulted = super::ModelSpec::new("12345678");
        provider.configure(&mut defaulted);
        assert_eq!(defaulted.context_window_tokens, Some(200_000));
    }

    fn input() -> ModelConfigInput {
        ModelConfigInput {
            sort_order: 1,
            display_name: "Model A".into(),
            group_name: None,
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/custom/generate".into(),
            use_full_url: true,
            api_key: "secret".into(),
            tooltip_data: "Model A".into(),
            model_id: "model-a".into(),
            reasoning_effort: Some("high".into()),
            effort_options: default_effort_options(),
            context_options: default_context_options(),
            openai_endpoint: OPENAI_RESPONSES_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: empty_object(),
            custom_headers_enabled: false,
            custom_headers: empty_object(),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: empty_object(),
            context_window_tokens: Some(200_000),
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    #[test]
    fn normalize_model_input_lowercases_effort_options() {
        let mut input = input();
        input.effort_options = vec!["LOW".into(), "High".into()];

        let normalized = normalize_model_input(&input).unwrap();

        assert_eq!(normalized.effort_options, vec!["low", "high"]);
    }

    #[test]
    fn hash_covers_url_model_key_name_and_endpoint() {
        let input = input();
        let expected = Sha256::digest(
            "https://example.com/custom/generate\nmodel-a\nsecret\nModel A\n/v1/responses"
                .as_bytes(),
        );
        assert_eq!(model_hash(&input).unwrap(), hex::encode(&expected[..8]));
    }

    #[test]
    fn request_url_is_exact_and_protocol_does_not_depend_on_its_path() {
        assert_eq!(
            resolve_request_url(
                ModelType::OpenAi,
                "https://example.com/custom/generate?api-version=2026-01-01",
                OPENAI_RESPONSES_ENDPOINT,
                true,
            )
            .unwrap(),
            "https://example.com/custom/generate?api-version=2026-01-01"
        );
        assert_eq!(
            resolve_request_url(
                ModelType::OpenAi,
                "https://example.com/another/arbitrary/path",
                OPENAI_CHAT_ENDPOINT,
                true,
            )
            .unwrap(),
            "https://example.com/another/arbitrary/path"
        );
        assert_eq!(
            resolve_request_url(ModelType::Anthropic, "https://example.com/claude", "", true)
                .unwrap(),
            "https://example.com/claude"
        );
        assert_eq!(
            resolve_request_url(
                ModelType::Anthropic,
                "https://example.com/claude/",
                "",
                true
            )
            .unwrap(),
            "https://example.com/claude/"
        );
        assert_eq!(
            resolve_request_url(
                ModelType::OpenAi,
                "https://example.com/v1",
                OPENAI_RESPONSES_ENDPOINT,
                false,
            )
            .unwrap(),
            "https://example.com/v1/responses"
        );
        assert_eq!(
            resolve_request_url(ModelType::Anthropic, "https://example.com/v1", "", false).unwrap(),
            "https://example.com/v1/messages"
        );
    }

    #[test]
    fn configured_context_window_fills_missing_client_value() {
        let input = input();
        let config = ModelConfig {
            model_hash: "hash".into(),
            sort_order: input.sort_order,
            display_name: input.display_name,
            group_name: None,
            enabled: true,
            model_type: input.model_type,
            base_url: input.base_url,
            use_full_url: input.use_full_url,
            api_key: input.api_key,
            tooltip_data: input.tooltip_data,
            model_id: input.model_id,
            reasoning_effort: input.reasoning_effort,
            effort_options: input.effort_options.clone(),
            context_options: input.context_options.clone(),
            openai_endpoint: input.openai_endpoint,
            openai_extra_params_enabled: input.openai_extra_params_enabled,
            openai_extra_params: input.openai_extra_params,
            custom_headers_enabled: input.custom_headers_enabled,
            custom_headers: input.custom_headers,
            anthropic_extra_params_enabled: input.anthropic_extra_params_enabled,
            anthropic_extra_params: input.anthropic_extra_params,
            context_window_tokens: Some(350_000),
            max_completion_tokens: input.max_completion_tokens,
            anthropic_max_tokens: input.anthropic_max_tokens,
            anthropic_thinking_effort: input.anthropic_thinking_effort,
            thinking_budget_tokens: input.thinking_budget_tokens,
            created_at_ms: 0,
            updated_at_ms: 0,
        };
        let mut requested = super::super::ModelSpec::new("model-a");

        config.configure(&mut requested);

        assert_eq!(requested.context_window_tokens, Some(350_000));
    }

    fn axis() -> ModelVariantAxis {
        ModelVariantAxis {
            context_options: vec!["200k".into(), "1m".into()],
            effort_options: vec!["low".into(), "high".into()],
        }
    }

    #[test]
    fn variant_slug_round_trips_with_and_without_fast() {
        let axis = axis();
        let parts = ModelVariantParts {
            context: "1m".into(),
            effort: Some("low".into()),
            fast: true,
        };
        let slug = axis.bake_slug("hash", &parts);
        assert_eq!(slug, "hash-1m-low-fast");
        assert_eq!(axis.parse_slug("hash", &slug), Some(parts));
        assert_eq!(
            axis.parse_slug("hash", "hash-200k-high"),
            Some(ModelVariantParts {
                context: "200k".into(),
                effort: Some("high".into()),
                fast: false,
            })
        );
        assert_eq!(axis.parse_slug("hash", "hash-1m"), None);
        assert_eq!(axis.parse_slug("hash", "hash-1m-gone"), None);
        assert_eq!(axis.parse_slug("hash", "other-1m-low"), None);
    }

    #[test]
    fn variant_slug_omits_the_effort_segment_when_the_model_has_no_reasoning_axis() {
        let axis = ModelVariantAxis {
            context_options: vec!["200k".into(), "1m".into()],
            effort_options: Vec::new(),
        };
        let parts = ModelVariantParts {
            context: "1m".into(),
            effort: None,
            fast: false,
        };
        assert_eq!(axis.bake_slug("hash", &parts), "hash-1m");
        assert_eq!(axis.parse_slug("hash", "hash-1m"), Some(parts));
        assert_eq!(
            axis.parse_slug("hash", "hash-1m-fast"),
            Some(ModelVariantParts {
                context: "1m".into(),
                effort: None,
                fast: true,
            })
        );
        assert_eq!(axis.parse_slug("hash", "hash-1m-low"), None);
        assert_eq!(
            axis.default_parts(),
            Some(ModelVariantParts {
                context: "200k".into(),
                effort: None,
                fast: false,
            })
        );
    }

    #[test]
    fn variant_slug_parses_the_catalog_bracket_representation() {
        let axis = axis();
        assert_eq!(
            axis.parse_slug("hash", "hash[context=1m,reasoning=low,fast=true]"),
            Some(ModelVariantParts {
                context: "1m".into(),
                effort: Some("low".into()),
                fast: true,
            })
        );
        assert_eq!(
            axis.parse_slug("hash", "hash[context=200k,reasoning=high,fast=false]"),
            Some(ModelVariantParts {
                context: "200k".into(),
                effort: Some("high".into()),
                fast: false,
            })
        );
        // Same rule as the hyphen slug: the tier must land on the axis.
        assert_eq!(
            axis.parse_slug("hash", "hash[context=2m,reasoning=low,fast=false]"),
            None
        );
        assert_eq!(
            axis.parse_slug("hash", "hash[context=1m,reasoning=gone,fast=false]"),
            None
        );
        assert_eq!(axis.parse_slug("hash", "hash[reasoning=low]"), None);

        let no_effort = ModelVariantAxis {
            context_options: vec!["200k".into(), "1m".into()],
            effort_options: Vec::new(),
        };
        assert_eq!(
            no_effort.parse_slug("hash", "hash[context=1m,fast=false]"),
            Some(ModelVariantParts {
                context: "1m".into(),
                effort: None,
                fast: false,
            })
        );
        assert_eq!(
            no_effort.parse_slug("hash", "hash[context=1m,reasoning=low,fast=false]"),
            None
        );
    }

    #[test]
    fn default_variant_prefers_the_catalog_defaults() {
        // Same rule as the catalog default variant: context prefers 200k over the configured window, effort prefers high.
        let axis = ModelVariantAxis {
            context_options: vec!["272k".into(), "200k".into(), "1m".into()],
            effort_options: vec!["low".into(), "high".into()],
        };
        assert_eq!(
            axis.default_parts(),
            Some(ModelVariantParts {
                context: "200k".into(),
                effort: Some("high".into()),
                fast: false,
            })
        );
        let without_preferred = ModelVariantAxis {
            context_options: vec!["272k".into(), "1m".into()],
            effort_options: vec!["low".into()],
        };
        assert_eq!(
            without_preferred.default_parts(),
            Some(ModelVariantParts {
                context: "272k".into(),
                effort: Some("low".into()),
                fast: false,
            })
        );
    }

    #[test]
    fn parameter_validation_normalizes_case_and_lists_valid_options() {
        let axis = axis();
        assert_eq!(axis.validate_effort("HIGH").unwrap(), "high");
        assert_eq!(axis.validate_context("200000").unwrap(), "200k");
        assert!(matches!(
            axis.validate_effort("gone"),
            Err(Error::Protocol(message)) if message.contains("low, high")
        ));
        assert!(matches!(
            axis.validate_context("2m"),
            Err(Error::Protocol(message)) if message.contains("200k, 1m")
        ));
        let no_effort = ModelVariantAxis {
            context_options: vec!["200k".into()],
            effort_options: Vec::new(),
        };
        assert!(no_effort.validate_effort("high").is_err());
    }
}
