import { useRef } from "react";
import type { ModelInput, ModelType } from "../../shared/api";
import { defaultContextOptions, defaultCustomHeadersText, defaultEffortOptions, formatTokenCount, parseOptions, parseTokenCount } from "../../shared/utils/modelDefaults";
import { modelPresets, presetEndpoint, trimTrailingSlash, type ModelPreset } from "../../shared/utils/modelPresets";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Combobox, Select, type ComboboxHandle } from "../../shared/ui/Select";
import { Switch } from "../../shared/ui/Switch";
import { claudeIcon, openAiIcon } from "../../shared/ui/icons";
import { CursorPresetChips } from "./CursorPresetChips";
import styles from "./CursorSettings.module.scss";

export type CursorModelDraft = {
  providerId: string;
  model: ModelInput;
  openAIExtraParamsText: string;
  customHeadersText: string;
  anthropicExtraParamsText: string;
};

export const emptyCursorModelDraft = (): CursorModelDraft => ({
  providerId: "builtin/openai",
  model: {
    sort_order: 0,
    display_name: "",
    group_name: null,
    type: "openai",
    base_url: "",
    use_full_url: false,
    api_key: "",
    tooltip_data: "",
    model_id: "",
    reasoning_effort: null,
    effort_options: [...defaultEffortOptions],
    context_options: [...defaultContextOptions],
    openai_endpoint: "/v1/responses",
    openai_extra_params_enabled: false,
    openai_extra_params: {},
    custom_headers_enabled: false,
    custom_headers: {},
    anthropic_extra_params_enabled: false,
    anthropic_extra_params: {},
    context_window_tokens: null,
    max_completion_tokens: null,
    anthropic_max_tokens: null,
    anthropic_thinking_effort: "xhigh",
    thinking_budget_tokens: null,
  },
  openAIExtraParamsText: "{}",
  customHeadersText: defaultCustomHeadersText,
  anthropicExtraParamsText: "{}",
});

export function CursorModelEditor({ draft, modelOptions, discovering, editingExisting, onChange, onDiscover }: {
  draft: CursorModelDraft;
  modelOptions: string[];
  discovering: boolean;
  editingExisting: boolean;
  onChange: (draft: CursorModelDraft) => void;
  onDiscover: () => Promise<boolean>;
}) {
  const modelCombobox = useRef<ComboboxHandle>(null);
  const setModel = (patch: Partial<ModelInput>) => onChange({ ...draft, model: { ...draft.model, ...patch } });
  const setType = (type: ModelType) => {
    // When switching protocol type, if the current URL matches another protocol's endpoint from a
    // preset, switch to that preset's endpoint for the new protocol — avoiding mismatches like
    // "type is Anthropic but the URL is an OpenAI chat/completions endpoint".
    const other: ModelType = type === "anthropic" ? "openai" : "anthropic";
    const preset = modelPresets.find((candidate) => trimTrailingSlash(presetEndpoint(candidate, other).baseUrl) === trimTrailingSlash(draft.model.base_url.trim()));
    const endpoint = preset ? presetEndpoint(preset, type) : null;
    onChange({
      ...draft,
      providerId: `builtin/${type}`,
      model: {
        ...draft.model,
        type,
        ...(endpoint ? {
          base_url: endpoint.baseUrl,
          use_full_url: endpoint.useFullUrl,
          custom_headers_enabled: endpoint.customHeaders !== null,
          custom_headers: endpoint.customHeaders ? { ...endpoint.customHeaders } : {},
        } : {}),
        openai_endpoint: type === "openai" ? (endpoint?.openaiEndpoint || draft.model.openai_endpoint || "/v1/responses") : "",
        anthropic_thinking_effort: type === "anthropic" ? draft.model.anthropic_thinking_effort || "xhigh" : null,
      },
      customHeadersText: endpoint?.customHeaders ? JSON.stringify(endpoint.customHeaders, null, 2) : draft.customHeadersText,
    });
  };
  const numberValue = (value: string) => value === "" ? null : Math.trunc(Number(value));
  // When editing an existing model the key field holds a masked placeholder; the server
  // backfills the stored key for the discovery request.
  const canDiscover = Boolean(draft.model.base_url.trim() && (draft.model.api_key.trim() || editingExisting));
  // After a preset is selected, merge that provider's known model IDs into the dropdown for easy
  // selection (models can still be discovered via "Fetch models").
  const presetModelOptions = modelPresets
    .filter((preset) => trimTrailingSlash(presetEndpoint(preset, draft.model.type).baseUrl) === trimTrailingSlash(draft.model.base_url.trim()))
    .flatMap((preset) => preset.models.map((item) => item.model_id));
  const combinedOptions = [...new Set([...modelOptions, ...presetModelOptions])];
  const discoverModels = async () => {
    if (await onDiscover()) modelCombobox.current?.openAll();
  };
  const applyPreset = (preset: ModelPreset) => {
    const endpoint = presetEndpoint(preset, draft.model.type);
    const first = preset.models[0];
    // The context window is no longer a standalone input: the preset window becomes the first
    // Context option (the first option is saved as the default).
    const presetContext = first?.context_window_tokens ?? null;
    // Switching to a different provider clears the API key (keys are not interchangeable across
    // providers); switching protocols within the same provider keeps it.
    const currentBase = trimTrailingSlash(draft.model.base_url.trim());
    const sameProvider = [preset.endpoints.anthropic, preset.endpoints.openai]
      .some((candidate) => trimTrailingSlash(candidate.baseUrl) === currentBase);
    onChange({
      ...draft,
      model: {
        ...draft.model,
        base_url: endpoint.baseUrl,
        use_full_url: endpoint.useFullUrl,
        openai_endpoint: draft.model.type === "openai" ? endpoint.openaiEndpoint : draft.model.openai_endpoint,
        custom_headers_enabled: endpoint.customHeaders !== null,
        custom_headers: endpoint.customHeaders ? { ...endpoint.customHeaders } : {},
        api_key: sameProvider ? draft.model.api_key : "",
        model_id: first?.model_id ?? draft.model.model_id,
        display_name: first?.display_name ?? draft.model.display_name,
        tooltip_data: !draft.model.tooltip_data.trim() || draft.model.tooltip_data === "Notes" ? preset.name : draft.model.tooltip_data,
        context_options: presetContext !== null
          ? [formatTokenCount(presetContext), ...draft.model.context_options.filter((value) => parseTokenCount(value) !== presetContext)]
          : draft.model.context_options,
        ...(draft.model.type === "openai"
          ? { max_completion_tokens: first?.max_output_tokens ?? draft.model.max_completion_tokens }
          : { anthropic_max_tokens: first?.max_output_tokens ?? draft.model.anthropic_max_tokens }),
      },
      customHeadersText: endpoint.customHeaders ? JSON.stringify(endpoint.customHeaders, null, 2) : draft.customHeadersText,
    });
  };
  const requestUrlPlaceholder = draft.model.use_full_url
    ? draft.model.type === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : draft.model.openai_endpoint === "/v1/chat/completions"
        ? "https://api.openai.com/v1/chat/completions"
        : "https://api.openai.com/v1/responses"
    : draft.model.type === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com";

  const providerOptions = [
    { value: "builtin/openai", label: "OpenAI", icon: openAiIcon },
    { value: "builtin/anthropic", label: "Anthropic", icon: claudeIcon },
  ];
  const setProvider = (providerId: string) => {
    if (providerId === "builtin/openai") setType("openai");
    if (providerId === "builtin/anthropic") setType("anthropic");
  };

  return <div className={styles.editor}>
    <CursorPresetChips type={draft.model.type} baseUrl={draft.model.base_url} onPick={applyPreset} />
    <div className={styles.grid}>
      <FormField label={"Model type"}><Select ariaLabel={"Model type"} value={draft.providerId} options={providerOptions} onChange={setProvider} /></FormField>
      {draft.model.type === "openai" && <FormField label={"Request protocol"} hint={"Only determines the request and response format; it does not change the request URL."}> <Select ariaLabel={"Request protocol"} value={draft.model.openai_endpoint} options={[
        { value: "/v1/responses", label: "Responses API" },
        { value: "/v1/chat/completions", label: "Chat Completions API" },
      ]} onChange={(openai_endpoint) => setModel({ openai_endpoint })} /></FormField>}

      <div className={styles.urlField}>
        <FormField label={draft.model.use_full_url ? "Complete request URL" : "Server address"} hint={draft.model.use_full_url ? "This address is used exactly as entered without changing or appending the request path." : "The standard endpoint path is appended automatically for the selected protocol."}> <TextInput placeholder={requestUrlPlaceholder} value={draft.model.base_url} onChange={(event) => setModel({ base_url: event.target.value })} /></FormField>
        <Checkbox checked={draft.model.use_full_url} label={"Use complete request URL"} onChange={(use_full_url) => setModel({ use_full_url })} />
      </div>
      <FormField label="API Key" hint={editingExisting ? "The key required to access the model service; shown as a placeholder when one is already saved, enter a new value to replace it." : "The key required to access the model service."}> <SecretTextInput placeholder="sk-xxxxxx" autoComplete="off" value={draft.model.api_key} onChange={(event) => setModel({ api_key: event.target.value })} /></FormField>

      <FormField label={"Model name"} hint={"Enter a model ID directly or load models returned by the API."}><Combobox ref={modelCombobox} value={draft.model.model_id} options={combinedOptions} placeholder="gpt-5" append={<Button className={styles.discoverButton} disabled={discovering || !canDiscover} onClick={() => void discoverModels()}>{discovering ? "Fetching…" : "Fetch models"}</Button>} onChange={(model_id) => setModel({ model_id, display_name: draft.model.display_name || model_id })} /></FormField>
      <FormField label={"Display name"} hint={"Used only for display and does not change the model name sent to the model service."}> <TextInput placeholder={"For example: Primary model"} value={draft.model.display_name} onChange={(event) => setModel({ display_name: event.target.value })} /></FormField>
      <FormField className={styles.fullWidth} label={"Notes"} hint={"Shown in the Cursor model description."}> <TextInput placeholder={"Enter model notes"} value={draft.model.tooltip_data} onChange={(event) => setModel({ tooltip_data: event.target.value })} /></FormField>

      <FormField label={"Effort options"} hint={"Comma-separated effort values supported by this model."}> <TextInput aria-label={"Effort options"} value={draft.model.effort_options.join(", ")} onChange={(event) => setModel({ effort_options: parseOptions(event.target.value) })} /></FormField>
      <FormField label={"Context options"} hint={"Comma-separated context values supported by this model, such as 200k, 1m."}> <TextInput aria-label={"Context options"} value={draft.model.context_options.join(", ")} onChange={(event) => setModel({ context_options: parseOptions(event.target.value) })} /></FormField>
      {draft.model.type === "openai" ? <>
        <FormField label={"Maximum output tokens"} hint={"Custom model context length. Once configured, the custom option takes priority."}> <TextInput type="number" min={1} step={1} placeholder={"e.g. 272000"} value={draft.model.max_completion_tokens ?? ""} onChange={(event) => setModel({ max_completion_tokens: numberValue(event.target.value) })} /></FormField>
        <FormField label={"Reasoning effort"}> <Select ariaLabel={"Reasoning effort"} value={draft.model.reasoning_effort ?? ""} options={effortOptions(true)} onChange={(value) => setModel({ reasoning_effort: value || null })} /></FormField>
      </> : <>
        <FormField label={"Maximum output tokens"} hint={"Custom model context length. Once configured, the custom option takes priority."}> <TextInput type="number" min={1} step={1} placeholder={"e.g. 272000"} value={draft.model.anthropic_max_tokens ?? ""} onChange={(event) => setModel({ anthropic_max_tokens: numberValue(event.target.value) })} /></FormField>
        <FormField label={"Reasoning effort"}> <Select ariaLabel={"Reasoning effort"} value={draft.model.anthropic_thinking_effort ?? "xhigh"} options={effortOptions(false)} onChange={(anthropic_thinking_effort) => setModel({ anthropic_thinking_effort })} /></FormField>
        <FormField label={"Thinking budget tokens"} hint={"Leave blank to use adaptive thinking."}> <TextInput type="number" min={1} step={1} placeholder={"Leave blank to use adaptive thinking"} value={draft.model.thinking_budget_tokens ?? ""} onChange={(event) => setModel({ thinking_budget_tokens: numberValue(event.target.value) })} /></FormField>
      </>}

      <ToggleJsonField
        label={"Custom Headers"}
        enabled={draft.model.custom_headers_enabled}
        text={draft.customHeadersText}
        onEnabledChange={(custom_headers_enabled) => setModel({ custom_headers_enabled })}
        onTextChange={(customHeadersText) => onChange({ ...draft, customHeadersText })}
      />
      {draft.model.type === "openai" ? <ToggleJsonField
        label={"OpenAI extra parameters"}
        enabled={draft.model.openai_extra_params_enabled}
        text={draft.openAIExtraParamsText}
        onEnabledChange={(openai_extra_params_enabled) => setModel({ openai_extra_params_enabled })}
        onTextChange={(openAIExtraParamsText) => onChange({ ...draft, openAIExtraParamsText })}
      /> : <ToggleJsonField
        label={"Anthropic extra parameters"}
        enabled={draft.model.anthropic_extra_params_enabled}
        text={draft.anthropicExtraParamsText}
        onEnabledChange={(anthropic_extra_params_enabled) => setModel({ anthropic_extra_params_enabled })}
        onTextChange={(anthropicExtraParamsText) => onChange({ ...draft, anthropicExtraParamsText })}
      />}
    </div>
  </div>;
}

function ToggleJsonField({ label, enabled, text, onEnabledChange, onTextChange }: {
  label: string;
  enabled: boolean;
  text: string;
  onEnabledChange: (enabled: boolean) => void;
  onTextChange: (text: string) => void;
}) {
  return <div className={`${styles.fullWidth} ${styles.jsonOption}`}>
    <label><span>{label}</span><Switch label={label} checked={enabled} onChange={onEnabledChange} /></label>
    {enabled && <JsonEditor ariaLabel={label} value={text} onChange={onTextChange} />}
  </div>;
}

function effortOptions(optional: boolean) {
  return [
    ...(optional ? [{ value: "", label: "Not set" }] : []),
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
  ];
}
