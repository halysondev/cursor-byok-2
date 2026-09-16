import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, configuredPluginModels, type Model, type ModelInput } from "../../shared/api";
import { CursorCaGate, CursorCaProvider, CursorModelGate, CursorModelProvider } from "./CursorGates";
import { CursorModelCards, cursorModelGroups, type CursorModelGroup, type CursorModelGrouping } from "./CursorModelCards";
import { CursorModelEditor, emptyCursorModelDraft, type CursorModelDraft } from "./CursorModelEditor";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import styles from "./CursorSettings.module.scss";
import { PageContent } from "../../shell/layout/PageContent";
import { LegacyModelImport } from "./LegacyModelImport";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { addIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";

export function CursorSettingsPage() {
  const { models, cursorHarness, cursorBusy, plugins } = useAppStore();
  const navigate = useNavigate();
  const message = useMessage();
  const [draft, setDraft] = useState<CursorModelDraft | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [caCommand, setCaCommand] = useState<string | null>(null);
  const [waitingForCaRefresh, setWaitingForCaRefresh] = useState(false);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [confirmDisableTakeover, setConfirmDisableTakeover] = useState(false);
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Map<string, CursorModelTestState>>(() => new Map());
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  const [grouping, setGrouping] = useState<CursorModelGrouping>("flat");
  const [settingsGroup, setSettingsGroup] = useState<CursorModelGroup | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupBaseUrlDraft, setGroupBaseUrlDraft] = useState("");
  const [groupApiKeyDraft, setGroupApiKeyDraft] = useState("");
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());
  const caReady = cursorHarness?.ca === "ready";
  const cursorTakenOver = cursorHarness?.settings_applied ?? false;
  const takeoverLabel = cursorTakenOver ? "Disable Cursor takeover" : "Enable Cursor takeover";
  const pluginModels = configuredPluginModels(plugins);
  const testTargets = [
    ...models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name })),
    ...pluginModels.map((model) => ({ model_hash: model.id, display_name: model.displayName })),
  ];
  const providerGroups = cursorModelGroups(models, "provider");
  const typeGroups = cursorModelGroups(models, "type");
  const canGroupByProvider = providerGroups.length > 1;
  const canGroupByType = typeGroups.length > 1;

  useEffect(() => {
    if ((grouping === "provider" && !canGroupByProvider) || (grouping === "type" && !canGroupByType)) {
      setGrouping("flat");
    }
  }, [canGroupByProvider, canGroupByType, grouping]);

  useEffect(() => {
    if (caCommand) void api.copyCursorText(caCommand);
  }, [caCommand]);

  const initializeCa = async () => {
    const status = await appStore.initializeCursorCa();
    if (status?.ca === "untrusted" && status.ca_install_command) setCaCommand(status.ca_install_command);
  };
  const openNew = () => {
    const next = emptyCursorModelDraft();
    next.model.sort_order = models.length + 1;
    setEditing(null);
    setModelOptions([]);
    setDraft(next);
  };
  const openEdit = (model: Model) => {
    setEditing(model);
    setModelOptions([model.model_id]);
    setDraft({
      providerId: `builtin/${model.type}`,
      model: modelInput(model),
      openAIExtraParamsText: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersText: JSON.stringify(model.custom_headers, null, 2),
      anthropicExtraParamsText: JSON.stringify(model.anthropic_extra_params, null, 2),
    });
  };
  const discover = async (): Promise<boolean> => {
    if (!draft) return false;
    setDiscovering(true);
    try {
      const custom_headers = parseHeaders(draft.customHeadersText);
      const result = await api.discoverModels({
        type: draft.model.type,
        base_url: draft.model.base_url.trim(),
        api_key: draft.model.api_key.trim(),
        custom_headers_enabled: draft.model.custom_headers_enabled,
        custom_headers,
      });
      setModelOptions([...new Set(result.models)]);
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  };
  const persist = async (): Promise<Model | null> => {
    if (!draft) return null;
    const input = draftInput(draft);
    if (editing) return appStore.updateCursorModel(editing.model_hash, input);
    return (await appStore.createModels([input]))?.[0] ?? null;
  };
  const save = async () => {
    try {
      if (await persist()) {
        setDraft(null);
        setEditing(null);
      }
    } catch (cause) {
      message(errorText(cause));
    }
  };
  const cancelModelTest = async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch (cause) {
      message(`Failed to cancel test: ${errorText(cause)}`, { duration: 5000 });
    }
  };
  const cancelAllModelTests = async () => {
    await Promise.all([...activeModelTests.current.keys()].map((modelHash) => cancelModelTest(modelHash)));
  };
  const testModel = async (model: { model_hash: string; display_name: string }, notify = true): Promise<"success" | "failure" | "cancelled"> => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelModelTest(model.model_hash);
      return "cancelled";
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testModel(model.model_hash, active.testId, active.controller.signal);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "success", result }));
      if (notify) message(`Connectivity test for ${model.display_name} succeeded (${result.duration_ms} ms)`);
      return "success";
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "cancelled" }));
        return "cancelled";
      }
      const error = errorText(cause);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "error", error }));
      if (notify) message(`Connectivity test failed: ${error}`, { duration: 5000 });
      return "failure";
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  };
  const saveAndTest = async () => {
    setSavingAndTesting(true);
    let saved: Model | null = null;
    try {
      saved = await persist();
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setSavingAndTesting(false);
    }
    if (!saved) return;
    setEditing(saved);
    await testModel(saved);
    await appStore.refresh();
  };
  const testAllModels = async () => {
    if (!testTargets.length || batchTesting) return;
    setBatchTesting(true);
    try {
      const results = await Promise.all(testTargets.map((model) => testModel(model, false)));
      const successful = results.filter((result) => result === "success").length;
      const failed = results.filter((result) => result === "failure").length;
      const cancelled = results.filter((result) => result === "cancelled").length;
      message(cancelled > 0
        ? `Connectivity test cancelled: ${successful} succeeded, ${failed} failed`
        : failed === 0
          ? `Connectivity tests succeeded for all ${testTargets.length} models`
          : `Connectivity tests completed: ${successful} succeeded, ${failed} failed`,
      { duration: failed === 0 && cancelled === 0 ? 2400 : 5000 });
    } finally {
      setBatchTesting(false);
    }
  };
  const duplicateModel = async (model: Model) => {
    const names = new Set(models.map((item) => item.display_name));
    const baseName = `${model.display_name} Copy`;
    let displayName = baseName;
    let suffix = 2;
    while (names.has(displayName)) {
      displayName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    const created = await appStore.createModels([{
      ...modelInput(model),
      sort_order: models.length + 1,
      display_name: displayName,
    }]);
    if (created) message("Model duplicated");
  };
  const openGroupSettings = (group: CursorModelGroup) => {
    setGroupNameDraft(group.models.find((model) => model.group_name?.trim())?.group_name?.trim() ?? "");
    setGroupBaseUrlDraft(sharedValue(group.models.map((model) => model.base_url)) ?? "");
    setGroupApiKeyDraft(sharedValue(group.models.map((model) => model.api_key)) ?? "");
    setSettingsGroup(group);
  };
  const saveGroupSettings = async () => {
    if (!settingsGroup) return;
    const group_name = groupNameDraft.trim() || null;
    const base_url = groupBaseUrlDraft.trim();
    const api_key = groupApiKeyDraft.trim();
    setGroupSettingsBusy(true);
    try {
      for (const model of settingsGroup.models) {
        const input: ModelInput = {
          ...modelInput(model),
          group_name,
          ...(base_url ? { base_url } : {}),
          ...(api_key ? { api_key } : {}),
        };
        if (input.group_name === (model.group_name ?? null)
          && input.base_url === model.base_url
          && input.api_key === model.api_key) continue;
        await api.updateModel(model.model_hash, input);
      }
      await appStore.refresh();
      setSettingsGroup(null);
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setGroupSettingsBusy(false);
    }
  };
  const reorderModels = useCallback(async (modelHashes: string[]) => {
    if (!await appStore.reorderCursorModels(modelHashes)) {
      message(appStore.getSnapshot().error || "Unable to save model order");
    }
  }, [message]);

  const list = <CursorModelCards
    models={models}
    pluginModels={pluginModels}
    grouping={grouping}
    disabled={cursorBusy}
    testingModelHashes={testingModelHashes}
    testResults={modelTestResults}
    onTest={(model) => void testModel(model)}
    onEdit={openEdit}
    onDuplicate={(model) => void duplicateModel(model)}
    onDelete={setDeleting}
    onTestPluginModel={(model) => void testModel({ model_hash: model.id, display_name: model.displayName })}
    onPluginSettings={() => navigate("/plugins")}
    onReorder={reorderModels}
    onGroupSettings={openGroupSettings}
  />;

  const refreshCa = async () => {
    await appStore.refresh();
    if (appStore.getSnapshot().cursorHarness?.ca !== "ready") setWaitingForCaRefresh(false);
  };
  const openCaTerminal = () => {
    if (caCommand) void api.openCursorCaInstallTerminal(caCommand).catch((cause) => message(errorText(cause)));
    setCaCommand(null);
    setWaitingForCaRefresh(true);
  };
  const content = <CursorCaProvider><CursorCaGate busy={cursorBusy} waitingForRefresh={waitingForCaRefresh} onInitialize={() => void initializeCa()} onRefresh={() => void refreshCa()}>
    <div className={styles.page}>
      <LegacyModelImport>{({ busy: importingLegacyModels, previewing, open }) =>
        <CursorModelProvider><CursorModelGate busy={cursorBusy || importingLegacyModels} previewingImport={previewing} onAdd={openNew} onImport={open}>{list}</CursorModelGate></CursorModelProvider>
      }</LegacyModelImport>
    </div>
  </CursorCaGate></CursorCaProvider>;

  const editorTestState = editing ? modelTestResults.get(editing.model_hash) : undefined;
  const editorTesting = Boolean(editing && testingModelHashes.has(editing.model_hash));
  const activeGroups = grouping === "provider" ? providerGroups : typeGroups;
  const pluginSectionHeight = pluginModels.length > 0 ? 60 + pluginModels.length * 56 : 0;
  const estimatedModelHeight = grouping === "flat"
    ? Math.max(380, Math.ceil(models.length / 3) * 196 + pluginSectionHeight)
    : Math.max(380, activeGroups.reduce((height, group) => height + 60 + group.models.length * 56, 0) + Math.max(0, activeGroups.length - 1) * 20 + pluginSectionHeight);

  return <>
    <PageActions position="left">
      <div className={styles.takeoverActions}>
        <span className={styles.takeoverStatus}>{cursorTakenOver ? "Taken over" : "Not taken over"}</span>
        <TooltipTrigger label={takeoverLabel}>
          <Switch
            checked={cursorTakenOver}
            disabled={cursorBusy || (!cursorTakenOver && !caReady)}
            label={takeoverLabel}
            onChange={(enabled) => {
              if (enabled) void appStore.setCursorEnabled(true);
              else setConfirmDisableTakeover(true);
            }}
          />
        </TooltipTrigger>
        {testTargets.length > 0 && <div className={styles.groupActions} role="group" aria-label={"Actions"}>
          <button type="button" aria-pressed={grouping === "flat"} onClick={() => setGrouping("flat")}>{"Default layout"}</button>
          {canGroupByProvider && <button type="button" aria-pressed={grouping === "provider"} onClick={() => setGrouping("provider")}>{"By provider"}</button>}
          {canGroupByType && <button type="button" aria-pressed={grouping === "type"} onClick={() => setGrouping("type")}>{"By type"}</button>}
          <button type="button" disabled={cursorBusy || (!batchTesting && testingModelHashes.size > 0)} onClick={() => void (batchTesting ? cancelAllModelTests() : testAllModels())}>{batchTesting ? "Cancel all tests" : "Test all"}</button>
        </div>}
      </div>
    </PageActions>
    <PageActions><TooltipTrigger label={caReady ? "Add model" : "Initialize the CA first"}><button className={controls.iconButton} aria-label={"Add model"} disabled={!caReady || cursorBusy} onClick={openNew}><Icon icon={addIcon} size="1.1em" /></button></TooltipTrigger></PageActions>
    <PageContent title="Cursor" sections={[{ key: "cursor-settings", estimatedHeight: estimatedModelHeight, content }]} />
    <ConfirmDialog
      open={confirmDisableTakeover}
      title={"Disable Cursor takeover?"}
      cancelLabel={"Cancel"}
      confirmLabel={"Disable takeover"}
      onCancel={() => setConfirmDisableTakeover(false)}
      onConfirm={() => {
        setConfirmDisableTakeover(false);
        void appStore.setCursorEnabled(false);
      }}
    >
      <p>{"Disabling this will remove Cursor's local proxy configuration. If you need to sign in to an official account, you usually do not need to disable it. You can sign in directly because BYOK models and official-account models now work together seamlessly. Do you want to continue disabling and clearing the proxy configuration?"}</p>
    </ConfirmDialog>
    <Modal fullHeight open={draft !== null} title={editing ? "Edit model" : "Add model"} banner={draft && (editorTesting || editorTestState) ? <CursorModelTestResult state={editorTestState} testing={editorTesting} /> : undefined} busy={cursorBusy || savingAndTesting} onClose={() => { if (editing && editorTesting) void cancelModelTest(editing.model_hash); setDraft(null); setEditing(null); }} onSubmit={() => void save()} submitLabel={"Save"} secondaryAction={<button type="button" className={controls.secondary} disabled={cursorBusy || savingAndTesting} onClick={() => void (editorTesting && editing ? cancelModelTest(editing.model_hash) : saveAndTest())}>{savingAndTesting ? "Processing…" : editorTesting ? "Cancel test" : "Save and test"}</button>}>
      {draft && <>
        <CursorModelEditor draft={draft} modelOptions={modelOptions} discovering={discovering} onChange={setDraft} onDiscover={discover} />
      </>}
    </Modal>
    <ConfirmDialog open={caCommand !== null} title={"Install local CA"} cancelLabel={"Close"} confirmLabel={"Open terminal"} onCancel={() => setCaCommand(null)} onConfirm={openCaTerminal}>
      <div className={styles.editor}><strong>{"Authorization is required to install the certificate"}</strong><span>{"The install command has been copied. Click “Open terminal”, paste it into the terminal, and enter your password when prompted."}</span><pre className={styles.command}>{caCommand}</pre></div>
    </ConfirmDialog>
    <Modal open={settingsGroup !== null} title={"Group settings"} busy={groupSettingsBusy || cursorBusy} onClose={() => setSettingsGroup(null)} onSubmit={() => void saveGroupSettings()} submitLabel={"Save"}>
      {settingsGroup && <div className={styles.editor}>
        <FormField label={"Group name"} hint={"Applies to every model in this group and is used as the badge label in Cursor's model picker; clear it to fall back to the server domain."}>
          <TextInput placeholder={settingsGroup.key} value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} />
        </FormField>
        <FormField label={"Server address"} hint={"Applies to every model in this group when changed; leave blank to keep each model's current configuration."}>
          <TextInput placeholder={"Leave blank to keep unchanged"} value={groupBaseUrlDraft} onChange={(event) => setGroupBaseUrlDraft(event.target.value)} />
        </FormField>
        <FormField label="API Key" hint={"Applies to every model in this group when changed; leave blank to keep each model's current configuration."}>
          <SecretTextInput placeholder={"Leave blank to keep unchanged"} autoComplete="off" value={groupApiKeyDraft} onChange={(event) => setGroupApiKeyDraft(event.target.value)} />
        </FormField>
      </div>}
    </Modal>
    <ConfirmDialog open={deleting !== null} title={"Delete model"} cancelLabel={"Cancel"} confirmLabel={"Delete"} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void appStore.deleteModel(deleting.model_hash); setDeleting(null); }}><p>{"Delete this model?"}</p></ConfirmDialog>
  </>;
}

function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}

/** Returns the value when every model in the group agrees, otherwise null (an empty form field keeps each model's current value). */
function sharedValue(values: string[]): string | null {
  const [first, ...rest] = values;
  if (first === undefined) return null;
  return rest.every((value) => value === first) ? first : null;
}

function draftInput(draft: CursorModelDraft): ModelInput {
  const model = {
    ...draft.model,
    display_name: draft.model.display_name.trim(),
    base_url: draft.model.base_url.trim(),
    api_key: draft.model.api_key.trim(),
    tooltip_data: draft.model.tooltip_data.trim(),
    model_id: draft.model.model_id.trim(),
    openai_extra_params: parseObject(draft.openAIExtraParamsText, "OpenAI extra parameters"),
    custom_headers: parseHeaders(draft.customHeadersText),
    anthropic_extra_params: parseObject(draft.anthropicExtraParamsText, "Anthropic extra parameters"),
  };
  if (!model.display_name || !model.base_url || !model.api_key || !model.tooltip_data || !model.model_id) throw new Error("Server address or complete request URL, API Key, model name, display name, and note are required");
  for (const [label, value] of [["Context window tokens", model.context_window_tokens], ["Maximum output tokens", model.type === "openai" ? model.max_completion_tokens : model.anthropic_max_tokens], ["Thinking budget tokens", model.thinking_budget_tokens]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${label} must be an integer greater than 0`);
  }
  return model;
}

function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, "Custom Headers");
  if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error("All custom Header values must be strings");
  return parsed as Record<string, string>;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
