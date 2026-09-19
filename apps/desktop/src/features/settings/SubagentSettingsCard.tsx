import { useCallback, useEffect, useMemo, useState } from "react";
import { api, pluginText, type SubagentRoutingSettings } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { TextInput } from "../../shared/ui/FormControls";
import { ModelSelect, type ModelSelectOption } from "../../shared/ui/ModelSelect";
import { TitledCard } from "../../shared/ui/TitledCard";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { modelProviderName } from "../../shared/utils/modelProvider";
import styles from "./SubagentSettingsCard.module.scss";

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SubagentSettingsCard() {
  const { models, plugins } = useAppStore();
  const message = useMessage();
  const [settings, setSettings] = useState<SubagentRoutingSettings | null>(null);
  const [draft, setDraft] = useState<SubagentRoutingSettings | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newAliasKey, setNewAliasKey] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await api.subagentRoutingSettings();
        if (active) {
          setSettings(loaded);
          setDraft(loaded);
        }
      } catch (cause) {
        if (active) message(errorText(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [message]);

  const modelOptions = useMemo(() => {
    const options: ModelSelectOption[] = [
      { value: "", label: "Default (first available model)", group: "Cursor" },
    ];
    const seen = new Set<string>();
    for (const model of models) {
      seen.add(model.model_hash);
      options.push({
        value: model.model_hash,
        label:
          model.display_name && model.display_name !== model.model_id
            ? `${model.display_name} (${model.model_id})`
            : model.display_name || model.model_id,
        group: modelProviderName(model),
        icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
      });
    }
    for (const plugin of plugins) {
      for (const provider of plugin.providers) {
        if (!provider.configured) continue;
        const group = pluginText(provider.displayName) || plugin.name;
        for (const model of provider.models.filter((model) => model.enabled)) {
          seen.add(model.id);
          options.push({
            value: model.id,
            label: model.displayName,
            group,
            iconSrc: model.icon || undefined,
            icon: model.icon ? undefined : flatColorOrganizationIcon,
          });
        }
      }
    }
    if (settings?.target_model_id && !seen.has(settings.target_model_id)) {
      seen.add(settings.target_model_id);
      options.push({ value: settings.target_model_id, label: settings.target_model_id, group: "Cursor" });
    }
    if (settings?.model_aliases) {
      for (const target of Object.values(settings.model_aliases)) {
        if (target && !seen.has(target)) {
          seen.add(target);
          options.push({ value: target, label: target, group: "Cursor" });
        }
      }
    }
    return options;
  }, [models, plugins, settings]);

  const resolveModelLabel = useCallback(
    (modelHash: string) => {
      if (!modelHash) return "Default (first available model)";
      const found = modelOptions.find((o) => o.value === modelHash);
      return found?.label ?? modelHash;
    },
    [modelOptions],
  );

  const startEdit = useCallback(() => {
    if (!settings) return;
    setDraft({
      ...settings,
      apply_to_subagents: settings.apply_to_subagents ?? true,
      apply_to_normal_chats: settings.apply_to_normal_chats ?? false,
      model_aliases: { ...settings.model_aliases },
    });
    setNewAliasKey("");
    setEditing(true);
  }, [settings]);

  const cancelEdit = useCallback(() => {
    setDraft(
      settings
        ? {
            ...settings,
            apply_to_subagents: settings.apply_to_subagents ?? true,
            apply_to_normal_chats: settings.apply_to_normal_chats ?? false,
            model_aliases: { ...settings.model_aliases },
          }
        : null,
    );
    setNewAliasKey("");
    setEditing(false);
  }, [settings]);

  const saveSettings = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await api.setSubagentRoutingSettings(draft);
      setSettings(saved);
      setDraft(saved);
      setEditing(false);
      message("Subagent routing settings saved");
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, message]);

  const updateAlias = useCallback(
    (key: string, targetModel: string) => {
      if (!draft) return;
      setDraft({
        ...draft,
        model_aliases: {
          ...draft.model_aliases,
          [key]: targetModel,
        },
      });
    },
    [draft],
  );

  const removeAlias = useCallback(
    (key: string) => {
      if (!draft) return;
      const nextAliases = { ...draft.model_aliases };
      delete nextAliases[key];
      setDraft({
        ...draft,
        model_aliases: nextAliases,
      });
    },
    [draft],
  );

  const addAlias = useCallback(() => {
    const trimmed = newAliasKey.trim();
    if (!trimmed || !draft) return;
    if (draft.model_aliases[trimmed] !== undefined) {
      message("Model alias already exists");
      return;
    }
    setDraft({
      ...draft,
      model_aliases: {
        ...draft.model_aliases,
        [trimmed]: "",
      },
    });
    setNewAliasKey("");
  }, [draft, newAliasKey, message]);

  const action = editing ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={saving} onClick={cancelEdit}>
        {"Cancel"}
      </Button>
      <Button
        variant="primary"
        size="small"
        disabled={saving}
        onClick={() => void saveSettings()}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : (
    <button
      type="button"
      className={styles.headerAction}
      disabled={!settings}
      onClick={startEdit}
    >
      {"Edit"}
    </button>
  );

  if (!settings && !editing) {
    return (
      <TitledCard title={"Subagent routing and model aliases"}>
        <div className={styles.content}>
          <div className={styles.row}>
            <span className={styles.value}>{"Loading…"}</span>
          </div>
        </div>
      </TitledCard>
    );
  }

  const displayData = editing ? draft : settings;
  const isEnabled = displayData?.enabled ?? false;
  const targetModel = displayData?.target_model_id ?? "";
  const aliases = displayData?.model_aliases ?? {};
  const applyToSubagents = displayData?.apply_to_subagents ?? true;
  const applyToNormalChats = displayData?.apply_to_normal_chats ?? false;

  const scopeLabel =
    applyToSubagents && applyToNormalChats
      ? "Subagents and normal chats"
      : applyToSubagents
        ? "Subagents only"
        : applyToNormalChats
          ? "Normal chats only"
          : "No scope enabled";

  return (
    <TitledCard title={"Subagent routing and model aliases"} action={action}>
      <div className={styles.content}>
        <div className={styles.row}>
          <div className={styles.details}>
            <strong>{"Enable subagent interception and model aliases"}</strong>
            <small>
              {"When enabled, subagent and Composer 2.5 calls are intercepted and redirected to a custom model; when disabled, requests go straight to the official upstream."}
            </small>
          </div>
          {editing && draft ? (
            <div className={styles.control}>
              <Checkbox
                checked={draft.enabled}
                label={"Enabled"}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </div>
          ) : (
            <span className={styles.value}>
              {isEnabled ? "Enabled" : "Disabled"}
            </span>
          )}
        </div>

        <div className={styles.row}>
          <div className={styles.details}>
            <strong>{"Apply to"}</strong>
            <small>
              {"Choose which request types the model aliases and interception rules apply to."}
            </small>
          </div>
          {editing && draft ? (
            <div className={styles.scopeControls}>
              <Checkbox
                checked={draft.apply_to_subagents}
                label={"Subagent calls"}
                disabled={saving}
                onChange={(checked) =>
                  setDraft({ ...draft, apply_to_subagents: checked })
                }
              />
              <Checkbox
                checked={draft.apply_to_normal_chats}
                label={"Normal chat calls"}
                disabled={saving}
                onChange={(checked) =>
                  setDraft({ ...draft, apply_to_normal_chats: checked })
                }
              />
            </div>
          ) : (
            <span className={styles.value}>{scopeLabel}</span>
          )}
        </div>

        <div className={styles.row}>
          <div className={styles.details}>
            <strong>{"Subagent default target model"}</strong>
            <small>
              {"Custom model used when intercepting subagents without a model (e.g. generalPurpose, explore)"}
            </small>
          </div>
          {editing && draft ? (
            <div className={styles.control}>
              <ModelSelect
                mode="single"
                value={draft.target_model_id}
                options={modelOptions}
                disabled={saving}
                label={"Subagent default target model"}
                onChange={(val) => setDraft({ ...draft, target_model_id: val })}
              />
            </div>
          ) : (
            <span className={styles.value}>{resolveModelLabel(targetModel)}</span>
          )}
        </div>

        <div className={styles.aliasesSection}>
          <div className={styles.details}>
            <strong>{"Hosted model alias rewrites"}</strong>
            <small>
              {"When a request names an official Cursor model, it is redirected to a local custom model. Leave blank to use the default target model above."}
            </small>
          </div>

          <div className={styles.aliasesList}>
            {Object.entries(aliases).map(([key, value]) => (
              <div key={key} className={styles.aliasRow}>
                <span className={styles.aliasKey}>{key}</span>
                {editing && draft ? (
                  <div className={styles.aliasSelect}>
                    <ModelSelect
                      mode="single"
                      value={value}
                      options={modelOptions}
                      disabled={saving}
                      label={key}
                      onChange={(targetHash) => updateAlias(key, targetHash)}
                    />
                    <button
                      type="button"
                      className={styles.deleteButton}
                      title={"Remove alias"}
                      aria-label={"Remove alias"}
                      onClick={() => removeAlias(key)}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <span className={styles.value}>{resolveModelLabel(value)}</span>
                )}
              </div>
            ))}
          </div>

          {editing && (
            <div className={styles.newAliasRow}>
              <div className={styles.newAliasInput}>
                <TextInput
                  value={newAliasKey}
                  placeholder={"Add a model alias, e.g. gemini-3.8-flash"}
                  onChange={(event) => setNewAliasKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addAlias();
                    }
                  }}
                />
              </div>
              <Button size="small" onClick={addAlias}>
                {"Add alias"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </TitledCard>
  );
}
