import { useEffect, useRef, useState } from "react";
import { api, getDisabledPluginModelIds, pluginText, type PluginDescriptor, type PluginImportFile, type PluginRuntimePhase, type PluginRuntimeStatus } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { ActionMenu, type ActionMenuItem } from "../../shared/ui/ActionMenu";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { Modal } from "../../shared/ui/Modal";
import { useMessage } from "../../shared/ui/message";
import { TruncatedButton } from "../../shared/ui/TruncatedButton";
import { PluginAddPanel, PluginSettingsPanel } from "./PluginResourcePanels";
import styles from "./PluginManagementPage.module.scss";

export function PluginManagementPage() {
  const { pluginRuntime, plugins } = useAppStore();
  const [progressOpen, setProgressOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<{ pluginId: string; mode: "add" | "settings" } | null>(null);
  const cancelRequested = useRef(false);
  const selectedPlugin = selected ? plugins.find((plugin) => plugin.id === selected.pluginId) ?? null : null;

  useEffect(() => {
    if (!pluginRuntime) void appStore.refreshPluginRuntime();
  }, [pluginRuntime]);

  useEffect(() => {
    if (pluginRuntime?.state !== "initializing") return;
    if (!cancelRequested.current) setProgressOpen(true);
    const timer = window.setInterval(() => void appStore.refreshPluginRuntime(), 300);
    return () => window.clearInterval(timer);
  }, [pluginRuntime?.state]);

  const initialize = async () => {
    if (starting) return;
    cancelRequested.current = false;
    setStarting(true);
    setProgressOpen(true);
    const status = await appStore.initializePluginRuntime();
    setStarting(false);
    if (!status) {
      setProgressOpen(false);
    } else if (cancelRequested.current && status.state === "initializing") {
      void appStore.cancelPluginRuntimeInitialization();
    }
  };

  const closeProgress = () => {
    setProgressOpen(false);
    cancelRequested.current = true;
    if (pluginRuntime?.state === "initializing") {
      void appStore.cancelPluginRuntimeInitialization();
    }
  };

  const content = pluginRuntime?.state === "ready"
    ? <PluginCards plugins={plugins} onOpen={(pluginId, mode) => setSelected({ pluginId, mode })} />
    : <RuntimeGate status={pluginRuntime} starting={starting} onInitialize={() => void initialize()} />;
  const estimatedHeight = plugins.length > 0
    ? Math.max(320, Math.ceil(plugins.length / 3) * 180)
    : 320;

  return <>
    <PageContent
      title={"Plugins"}
      sections={[{ key: "installed-plugins", estimatedHeight, content }]}
    />
    <RuntimeProgressModal
      open={progressOpen}
      status={pluginRuntime}
      starting={starting}
      onClose={closeProgress}
    />
    <Modal
      fullHeight
      open={selectedPlugin !== null}
      title={selected?.mode === "settings"
        ? `${selectedPlugin?.name ?? ""} accounts`
        : `Add ${selectedPlugin?.name ?? ""} account`}
      onClose={() => setSelected(null)}
      onSubmit={() => setSelected(null)}
      submitLabel={"Confirm"}
    >
      {selected?.mode === "add" && selectedPlugin && <PluginAddPanel plugin={selectedPlugin} onConfigured={() => setSelected(null)} />}
      {selected?.mode === "settings" && selectedPlugin && <PluginSettingsPanel plugin={selectedPlugin} onResourcesEmpty={() => setSelected(null)} />}
    </Modal>
  </>;
}

function RuntimeGate({ status, starting, onInitialize }: { status: PluginRuntimeStatus | null; starting: boolean; onInitialize: () => void }) {
  const checking = status === null;
  const initializing = starting || status?.state === "initializing";
  const failed = status?.state === "failed";
  const unsupported = status?.state === "unsupported";
  const title = checking
    ? "Checking the plugin runtime"
    : failed
      ? "Plugin runtime initialization failed"
      : unsupported
        ? "Plugin runtime is not supported on this system"
        : "Initialize the plugin runtime first";
  const description = failed
    ? "Try initializing again"
    : unsupported
      ? status.error ?? "This operating system or CPU architecture is not currently supported"
      : "Initialization downloads and installs the plugin runtime.";

  return <div className={styles.gate}>
    <strong>{title}</strong>
    <span>{description}</span>
    {!unsupported && <Button variant="primary" disabled={checking || initializing} onClick={onInitialize}>
      {checking ? "Checking…" : initializing ? "Initializing…" : failed ? "Reinitialize plugins" : "Initialize plugins"}
    </Button>}
  </div>;
}

function PluginCards({ plugins, onOpen }: {
  plugins: PluginDescriptor[];
  onOpen: (pluginId: string, mode: "add" | "settings") => void;
}) {
  if (plugins.length === 0) {
    return <div className={styles.empty}>
      <strong>{"No plugins installed"}</strong>
      <span>{"Installed plugins will appear here."}</span>
    </div>;
  }
  return <div className={styles.pluginGrid}>
    {plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} onOpen={onOpen} />)}
  </div>;
}

function PluginCard({ plugin, onOpen }: {
  plugin: PluginDescriptor;
  onOpen: (pluginId: string, mode: "add" | "settings") => void;
}) {
  const { ports } = useAppStore();
  const message = useMessage();
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const configured = plugin.providers.some((provider) => provider.configured);
  const accountCount = plugin.resources.reduce((count, resource) => count + resource.resources.length, 0);
  const [disabledModelIds, setDisabledModelIds] = useState<Set<string>>(() => getDisabledPluginModelIds());
  useEffect(() => {
    const handleUpdate = () => setDisabledModelIds(getDisabledPluginModelIds());
    window.addEventListener("cursor_plugin_models_changed", handleUpdate);
    return () => window.removeEventListener("cursor_plugin_models_changed", handleUpdate);
  }, []);

  const modelCount = plugin.providers.reduce(
    (count, provider) => count + provider.models.filter((m) => !disabledModelIds.has(m.id) && m.enabled).length,
    0,
  );
  const subtitle = plugin.providers.map((provider) => pluginText(provider.displayName)).join(" · ") || plugin.id;
  const importResource = plugin.resources.find((resource) => resource.import);
  const exportResource = plugin.resources.find((resource) => resource.resources.length > 0);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length || !importResource) return;
    setImporting(true);
    try {
      const entries: PluginImportFile[] = await Promise.all(
        [...files].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      const result = await api.importPluginResources(plugin.id, importResource.type, entries);
      await appStore.refreshPlugins();
      const summary = `Import finished: ${result.added} added, ${result.updated} updated`;
      if (result.modelSyncError) {
        message(`The account was saved, but model sync failed: ${result.modelSyncError}`, { duration: 5000 });
      } else if (result.warnings.length > 0) {
        message(`${summary} · ${result.warnings.join("; ")}`, { duration: 5000 });
      } else {
        message(summary);
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause), { duration: 5000 });
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  const moreItems: ActionMenuItem[] = [
    ...(importResource
      ? [
          {
            id: "import",
            label: importing ? "Importing…" : "Bulk import",
            disabled: importing,
            onSelect: () => importInput.current?.click(),
          },
        ]
      : []),
    ...(exportResource
      ? [
          {
            id: "export",
            label: "Bulk export",
            onSelect: () =>
              void api.openExternalUrl(
                api.pluginResourceExportUrl(
                  ports.service_port,
                  plugin.id,
                  exportResource.type,
                ),
              ),
          },
        ]
      : []),
    ...(plugin.version
      ? [{ id: "version", type: "text" as const, label: `v${plugin.version}` }]
      : []),
  ];

  return (
    <Card className={styles.pluginCard}>
      <div className={styles.pluginCardTop}>
        <img className={styles.pluginIcon} src={plugin.icon} />
        <div className={styles.pluginIdentity}>
          <span className={styles.pluginName}>{plugin.name}</span>
          <span className={styles.pluginId}>{subtitle}</span>
        </div>
        <span
          className={`${styles.stateBadge} ${configured ? styles.stateReady : ""}`}
        >
          {configured ? "Configured" : "Not configured"}
        </span>
      </div>
      <div className={styles.pluginMeta}>
        <span>
          {`${accountCount} accounts · ${modelCount} models`}
        </span>
        {plugin.author && (
          <span className={styles.pluginAuthor}>{plugin.author}</span>
        )}
      </div>
      <div className={styles.cardActions}>
        <TruncatedButton
          size="small"
          variant="primary"
          label={"Add account"}
          onClick={() => onOpen(plugin.id, "add")}
        />
        {configured && (
          <TruncatedButton
            size="small"
            label={"Manage accounts"}
            onClick={() => onOpen(plugin.id, "settings")}
          />
        )}
        {moreItems.length > 0 && (
          <span className={styles.moreAction}>
            <ActionMenu label={"More"} items={moreItems} />
          </span>
        )}
        {importResource && (
          <input
            ref={importInput}
            type="file"
            hidden
            accept={importResource.import?.accept.join(",")}
            multiple={importResource.import?.multiple ?? false}
            onChange={(event) => void importFiles(event.target.files)}
          />
        )}
      </div>
    </Card>
  );
}

function RuntimeProgressModal({ open, status, starting, onClose }: { open: boolean; status: PluginRuntimeStatus | null; starting: boolean; onClose: () => void }) {
  const initializing = starting || status?.state === "initializing";
  const downloaded = status?.downloaded_bytes ?? 0;
  const total = status?.total_bytes ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const stage = status?.state === "ready"
    ? "Plugin runtime initialized"
    : status?.state === "failed"
      ? "Plugin runtime initialization failed"
      : phaseText(status?.phase ?? null);

  return <Modal
    open={open}
    title={"Initialize plugin runtime"}
    closeLabel={status?.state === "ready" ? "Done" : initializing ? "Cancel" : "Close"}
    onClose={onClose}
  >
    <div className={styles.progressContent} aria-live="polite">
      <strong>{stage}</strong>
      {status?.phase === "downloading" && <>
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-label={"Download progress"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <div
            className={styles.progressFill}
            style={{ width: `${percent ?? 100}%` }}
          />
        </div>
        <span>
          {total ? `Downloaded ${formatBytes(downloaded)} / ${formatBytes(total)}` : `Downloaded ${formatBytes(downloaded)}`}
        </span>
      </>}
      {status?.state === "failed" && <span className={styles.error}>{"Try initializing again"}</span>}
      {status?.state === "ready" && <span>{`Plugin runtime ${status.version} is installed and ready to use.`}</span>}
    </div>
  </Modal>;
}

function phaseText(phase: PluginRuntimePhase | null) {
  switch (phase) {
    case "checking": return "Checking the plugin runtime";
    case "downloading": return "Downloading the plugin runtime";
    case "verifying": return "Verifying the plugin runtime download";
    case "installing": return "Installing the plugin runtime";
    case "validating": return "Validating the plugin runtime";
    default: return "Preparing the plugin runtime";
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}
