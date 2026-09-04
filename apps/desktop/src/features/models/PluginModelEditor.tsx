import { forwardRef, useImperativeHandle, useState } from "react";
import type { PluginModelDescriptor, PluginModelOverrideInput } from "../../shared/api";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import styles from "./CursorSettings.module.scss";

function parseOptions(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export type PluginModelEditorHandle = { save: () => void };

type PluginModelEditorProps = {
  model: PluginModelDescriptor;
  busy: boolean;
  onSave: (input: PluginModelOverrideInput) => void;
};

export const PluginModelEditor = forwardRef<PluginModelEditorHandle, PluginModelEditorProps>(function PluginModelEditor({ model, busy, onSave }, ref) {
  const [displayName, setDisplayName] = useState(model.displayName);
  const [tooltip, setTooltip] = useState(model.description ?? "");
  const [effortText, setEffortText] = useState(model.effortOptions.join(", "));
  const [contextText, setContextText] = useState(model.contextOptions.join(", "));
  const [maxTokensText, setMaxTokensText] = useState(model.maxOutputTokens === null ? "" : String(model.maxOutputTokens));
  useImperativeHandle(ref, () => ({
    save: () => onSave({
      id: model.id,
      displayName: displayName.trim(),
      tooltip: tooltip.trim(),
      effortOptions: parseOptions(effortText),
      contextOptions: parseOptions(contextText),
      maxOutputTokens: maxTokensText === "" ? null : Math.trunc(Number(maxTokensText)),
    }),
  }));
  return <div className={styles.editor}>
    <div className={styles.grid}>
      <FormField label={"Model name"}><div className={styles.staticValue}>{model.modelId}</div></FormField>
      <FormField label={"Display name"} hint={"Used only for display and does not change the model name sent to the model service."}>
        <TextInput value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} />
      </FormField>
      <FormField className={styles.fullWidth} label={"Notes"} hint={"Shown in the Cursor model description."}>
        <TextInput value={tooltip} disabled={busy} onChange={(event) => setTooltip(event.target.value)} />
      </FormField>
      <FormField label={"Effort options"} hint={"Comma-separated effort values supported by this model."}>
        <TextInput aria-label={"Effort options"} value={effortText} disabled={busy} onChange={(event) => setEffortText(event.target.value)} />
      </FormField>
      <FormField label={"Context options"} hint={"Comma-separated context values supported by this model, such as 200k, 1m."}>
        <TextInput aria-label={"Context options"} value={contextText} disabled={busy} onChange={(event) => setContextText(event.target.value)} />
      </FormField>
      <FormField label={"Maximum output tokens"} hint={"Leave blank to use the default."}>
        <TextInput type="number" min={1} step={1} placeholder={"Leave blank to use the default"} value={maxTokensText} disabled={busy} onChange={(event) => setMaxTokensText(event.target.value)} />
      </FormField>
    </div>
  </div>;
});
