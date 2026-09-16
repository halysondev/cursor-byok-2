import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  pluginText,
  type PluginAddMethod,
  type PluginDescriptor,
  type PluginOAuthBegin,
  type PluginProviderDescriptor,
  type PluginResourceAction,
  type PluginResourceActionCard,
  type PluginResourceActionResult,
  type PluginResourceDescriptor,
  type PluginResourceView,
} from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import styles from "./PluginResourcePanels.module.scss";

const PAGE_SIZE = 10;

export function PluginAddPanel({ plugin, onConfigured }: { plugin: PluginDescriptor; onConfigured: () => void }) {
  return <div className={styles.panel}>
    {plugin.resources.map((resource) => <ResourceAddSection
      key={resource.type}
      plugin={plugin}
      resource={resource}
      onConfigured={onConfigured}
    />)}
    {plugin.resources.length === 0 && <span className={styles.empty}>{"This plugin does not need any resources."}</span>}
  </div>;
}

function ResourceAddSection({ plugin, resource, onConfigured }: {
  plugin: PluginDescriptor;
  resource: PluginResourceDescriptor;
  onConfigured: () => void;
}) {
  return <>
    {resource.add.map((method) => <OAuthMethodCard
      key={method.id}
      pluginId={plugin.id}
      resourceType={resource.type}
      method={method}
      onConfigured={onConfigured}
    />)}
  </>;
}

function OAuthMethodCard({ pluginId, resourceType, method, onConfigured }: {
  pluginId: string;
  resourceType: string;
  method: PluginAddMethod;
  onConfigured: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "starting" | "polling" | "success" | "error">("idle");
  const [begun, setBegun] = useState<PluginOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stopped = useRef(false);

  const copyCode = async (code: string) => {
    await api.copyCursorText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => { stopped.current = true; }, []);

  useEffect(() => {
    if (!begun || status !== "polling") return;
    let timer = 0;
    const poll = async (intervalMs: number) => {
      if (stopped.current) return;
      try {
        const result = await api.pluginOAuthPoll(begun.sessionId);
        if (stopped.current) return;
        if (result.status === "pending") {
          timer = window.setTimeout(() => void poll(result.pollIntervalMs), Math.max(1000, result.pollIntervalMs));
          return;
        }
        if (result.status === "completed") {
          await appStore.refreshPlugins();
          if (result.modelSyncError) {
            setStatus("error");
            setError(`The account was saved, but model sync failed: ${result.modelSyncError}`);
            return;
          }
          setStatus("success");
          onConfigured();
          return;
        }
        setStatus("error");
        setError(result.message || "Authorization was denied or failed.");
      } catch (cause) {
        if (stopped.current) return;
        setError(errorText(cause));
        timer = window.setTimeout(() => void poll(intervalMs), Math.max(1000, intervalMs));
      }
    };
    timer = window.setTimeout(() => void poll(begun.pollIntervalMs), Math.max(1000, begun.pollIntervalMs));
    return () => window.clearTimeout(timer);
  }, [begun, onConfigured, status]);

  const start = async () => {
    setStatus("starting");
    setError(null);
    try {
      const next = await api.pluginOAuthBegin(pluginId, resourceType, method.id);
      setBegun(next);
      setStatus("polling");
      if (next.userCode) await api.copyCursorText(next.userCode).catch(() => undefined);
      await api.openExternalUrl(next.verificationUrlComplete || next.verificationUrl);
    } catch (cause) {
      setStatus("error");
      setError(errorText(cause));
    }
  };

  const userCode = begun?.userCode;
  return <Card className={styles.methodCard}>
    <strong>{pluginText(method.displayName)}</strong>
    {method.description && <span>{pluginText(method.description)}</span>}
    {userCode && status === "polling" && <div className={styles.deviceCode}>
      <small>{"Device code"}</small>
      <button type="button" onClick={() => void copyCode(userCode)}>{userCode}</button>
      <button type="button" className={styles.copy} onClick={() => void copyCode(userCode)}>
        {copied ? "Copied" : "Duplicate"}
      </button>
    </div>}
    <div className={styles.actions}>
      <Button variant="primary" disabled={status === "starting" || status === "polling"} onClick={() => void start()}>
        {status === "starting" ? "Requesting an authorization code…" : status === "polling" ? "Waiting for browser authorization…" : "Start sign-in"}
      </Button>
      {begun && status === "polling" && <Button onClick={() => void api.openExternalUrl(begun.verificationUrlComplete || begun.verificationUrl)}>{"Open authorization page"}</Button>}
    </div>
    {status === "success" && <span className={styles.success}>{"Account saved and the model catalog is synced."}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

export function PluginSettingsPanel({ plugin }: { plugin: PluginDescriptor }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelProviderId, setModelProviderId] = useState<string | null>(null);
  const [resourceAction, setResourceAction] = useState<{
    resource: PluginResourceDescriptor;
    item: PluginResourceView;
  } | null>(null);
  const [resourceActionResult, setResourceActionResult] = useState<PluginResourceActionResult | null>(null);
  const [resourceActionError, setResourceActionError] = useState<string | null>(null);
  const modelProvider = modelProviderId ? plugin.providers.find((provider) => provider.id === modelProviderId) ?? null : null;

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
      await appStore.refreshPlugins();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const executeResourceAction = async (
    target: { resource: PluginResourceDescriptor; item: PluginResourceView },
    action: PluginResourceAction,
    input: unknown = {},
  ) => {
    const key = `action:${target.item.id}:${action.id}`;
    setBusy(key);
    setResourceActionError(null);
    try {
      const result = await api.pluginResourceAction(
        plugin.id,
        target.resource.type,
        target.item.id,
        action.id,
        input,
      );
      setResourceActionResult(result);
      await appStore.refreshPlugins();
    } catch (cause) {
      setResourceActionError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const openResourceAction = (resource: PluginResourceDescriptor, item: PluginResourceView, action: PluginResourceAction) => {
    setResourceAction({ resource, item });
    setResourceActionResult(null);
    setResourceActionError(null);
    void executeResourceAction({ resource, item }, action);
  };

  return <div className={styles.panel}>
    {plugin.providers.map((provider) => <ProviderRow
      key={provider.id}
      provider={provider}
      busy={busy !== null}
      syncing={busy === `sync:${provider.id}`}
      onManageModels={() => setModelProviderId(provider.id)}
      onSync={() => void run(`sync:${provider.id}`, async () => {
        await api.syncPluginModels(plugin.id, provider.id);
      })}
    />)}
    {plugin.resources.map((resource) => <ResourceList
      key={resource.type}
      resource={resource}
      busy={busy !== null}
      onAction={(item, action) => openResourceAction(resource, item, action)}
      onRefresh={(item) => void run(`refresh:${item.id}`, async () => {
        await api.refreshPluginResource(plugin.id, resource.type, item.id);
      })}
      onDelete={(item) => void run(`delete:${item.id}`, async () => {
        await api.deletePluginResource(plugin.id, resource.type, item.id);
      })}
    />)}
    {error && <span className={styles.error} role="alert">{error}</span>}
    {modelProvider && <ModelManagementModal
      provider={modelProvider}
      busy={busy !== null}
      onClose={() => setModelProviderId(null)}
      onSubmit={(enabledByModel) => void run("models", async () => {
        for (const model of modelProvider.models) {
          const enabled = enabledByModel[model.id] ?? model.enabled;
          if (model.enabled !== enabled) await api.setPluginModelEnabled(plugin.id, modelProvider.id, model.modelId, enabled);
        }
      })}
    />}
    {resourceAction && <ResourceActionModal
      action={resourceAction.resource.actions.find((item) => item.target === "resource") ?? null}
      cardAction={resourceAction.resource.actions.find((item) => item.target === "card") ?? null}
      result={resourceActionResult}
      busy={busy !== null}
      error={resourceActionError}
      onClose={() => setResourceAction(null)}
      onCardAction={(action, card) => void executeResourceAction(resourceAction, action, { cardId: card.id })}
    />}
  </div>;
}

function ProviderRow({ provider, busy, syncing, onManageModels, onSync }: {
  provider: PluginProviderDescriptor;
  busy: boolean;
  syncing: boolean;
  onManageModels: () => void;
  onSync: () => void;
}) {
  return <Card className={styles.providerRow}>
    <div>
      <strong>{pluginText(provider.displayName)}</strong>
      <span>
        {provider.providerType}
        {" · "}
        {provider.models.length > 0 ? `${provider.models.length} models` : "Models not synced yet"}
        {" · "}
        {provider.configured ? "Callable" : "Not ready"}
      </span>
    </div>
    {provider.hasModels && <div className={styles.actions}>
      <Button size="small" disabled={busy || provider.models.length === 0} onClick={onManageModels}>{"Model management"}</Button>
      <Button size="small" disabled={busy} onClick={onSync}>
        {syncing ? "Syncing…" : "Sync models"}
      </Button>
    </div>}
  </Card>;
}

function ModelManagementModal({ provider, busy, onClose, onSubmit }: {
  provider: PluginProviderDescriptor;
  busy: boolean;
  onClose: () => void;
  onSubmit: (enabledByModel: Record<string, boolean>) => void;
}) {
  const [enabledByModel, setEnabledByModel] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setEnabledByModel(Object.fromEntries(provider.models.map((model) => [model.id, model.enabled])));
  }, [provider.models]);

  const setAll = (enabled: boolean) => {
    setEnabledByModel(Object.fromEntries(provider.models.map((model) => [model.id, enabled])));
  };

  return <Modal
    fullHeight
    open
    title={`${pluginText(provider.displayName)} model management`}
    busy={busy}
    onClose={onClose}
    onSubmit={() => onSubmit(enabledByModel)}
    submitLabel={"Confirm"}
  >
    <div className={styles.modelToolbar}>
      <Button size="small" disabled={busy || provider.models.length === 0} onClick={() => setAll(true)}>{"Select all"}</Button>
      <Button size="small" disabled={busy || provider.models.length === 0} onClick={() => setAll(false)}>{"Deselect all"}</Button>
    </div>
    <div className={styles.modelTableWrap}>
      <table className={styles.modelTable}>
        <thead><tr><th scope="col">{"Model name"}</th><th scope="col">{"Enabled"}</th></tr></thead>
        <tbody>
          {provider.models.map((model) => <tr key={model.id}>
            <td><div className={styles.modelName}>
              <strong>{model.displayName}</strong>
              {model.description && <span>{model.description}</span>}
            </div></td>
            <td><Switch
              checked={enabledByModel[model.id] ?? model.enabled}
              disabled={busy}
              label={`Enable ${model.displayName}`}
              onChange={(enabled) => setEnabledByModel((current) => ({ ...current, [model.id]: enabled }))}
            /></td>
          </tr>)}
        </tbody>
      </table>
      {provider.models.length === 0 && <span className={styles.empty}>{"Models not synced yet"}</span>}
    </div>
  </Modal>;
}

function ResourceList({ resource, busy, onAction, onRefresh, onDelete }: {
  resource: PluginResourceDescriptor;
  busy: boolean;
  onAction: (item: PluginResourceView, action: PluginResourceAction) => void;
  onRefresh: (item: PluginResourceView) => void;
  onDelete: (item: PluginResourceView) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () => resource.resources.filter((item) => item.displayName.toLowerCase().includes(query.trim().toLowerCase())),
    [resource.resources, query],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * PAGE_SIZE, Math.min(page, pageCount) * PAGE_SIZE);

  useEffect(() => setPage(1), [query]);

  return <FormField label={pluginText(resource.displayName)}>
    <div className={styles.resourceSection}>
      {resource.resources.length > PAGE_SIZE && <div className={styles.toolbar}>
        <TextInput aria-label={"Search resources"} placeholder={"Search resources"} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>}
      <div className={styles.resourceList}>
        {visible.map((item) => <ResourceRow
          key={item.id}
          item={item}
          actions={resource.actions.filter((action) => action.target === "resource")}
          canRefresh={resource.canRefresh}
          disabled={busy}
          onAction={(action) => onAction(item, action)}
          onRefresh={() => onRefresh(item)}
          onDelete={() => onDelete(item)}
        />)}
        {visible.length === 0 && <span className={styles.empty}>{"No resources yet. Add one first."}</span>}
      </div>
      {pageCount > 1 && <div className={styles.pagination}>
        <Button size="small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>{"Previous page"}</Button>
        <span>{`Page ${Math.min(page, pageCount)} / ${pageCount}`}</span>
        <Button size="small" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>{"Next page"}</Button>
      </div>}
    </div>
  </FormField>;
}

function ResourceRow({ item, actions, canRefresh, disabled, onAction, onRefresh, onDelete }: {
  item: PluginResourceView;
  actions: PluginResourceAction[];
  canRefresh: boolean;
  disabled: boolean;
  onAction: (action: PluginResourceAction) => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  return <Card className={styles.resourceRow}>
    <div>
      <strong>{item.displayName}</strong>
      {item.description && <span>{pluginText(item.description)}</span>}
      {item.metrics.map((metric) => <span key={metric.id}>
        {metric.unit === "percent"
          ? `${pluginText(metric.label)}: ${Math.round(metric.value)}% left`
          : `${pluginText(metric.label)}: ${metric.value}`}
      </span>)}
    </div>
    <div className={styles.actions}>
      <StateBadge state={item.state} />
      {actions.map((action) => <Button key={action.id} size="small" disabled={disabled} onClick={() => onAction(action)}>{pluginText(action.displayName)}</Button>)}
      {canRefresh && <Button size="small" disabled={disabled} onClick={onRefresh}>{"Refresh"}</Button>}
      <Button size="small" disabled={disabled} onClick={onDelete}>{"Delete"}</Button>
    </div>
  </Card>;
}

function ResourceActionModal({ action, cardAction, result, busy, error, onClose, onCardAction }: {
  action: PluginResourceAction | null;
  cardAction: PluginResourceAction | null;
  result: PluginResourceActionResult | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCardAction: (action: PluginResourceAction, card: PluginResourceActionCard) => void;
}) {
  const [pendingCard, setPendingCard] = useState<PluginResourceActionCard | null>(null);
  const title = result ? pluginText(result.title) : action ? pluginText(action.displayName) : "Resource details";
  const cardActions = cardAction ? [cardAction] : [];

  return <>
    <Modal compact open title={title} busy={busy} onClose={onClose} submitLabel={"Close"} onSubmit={onClose}>
      <div className={styles.actionBody}>
        {result?.description && <span className={styles.actionDescription}>{pluginText(result.description)}</span>}
        {busy && <span className={styles.empty}>{"Loading…"}</span>}
        {error && <span className={styles.error} role="alert">{error}</span>}
        {!busy && !error && result && result.cards.length === 0 && <span className={styles.empty}>{"No reset cards available."}</span>}
        {!busy && !error && result && <div className={styles.actionCardList}>
        {result.cards.map((card) => <Card key={card.id} className={styles.actionCard}>
          <div className={styles.actionCardMain}>
            <strong>{pluginText(card.title)}</strong>
            {card.status && <span>{formatActionStatus(card.status)}</span>}
            {card.grantedAtMs !== null && card.grantedAtMs !== undefined && <span>{`Granted: ${formatActionDate(card.grantedAtMs)}`}</span>}
            {card.expiresAtMs !== null && card.expiresAtMs !== undefined && <span>{`Expires: ${formatActionDate(card.expiresAtMs)}`}</span>}
            {card.fields.map((field) => <span key={field.id}>{pluginText(field.label)}: {field.value}</span>)}
          </div>
          {cardActions.length > 0 && <div className={styles.actions}>
            {cardActions.map((cardActionItem) => <Button
              key={cardActionItem.id}
              size="small"
              disabled={busy || card.status !== "available"}
              onClick={() => cardActionItem.destructive ? setPendingCard(card) : onCardAction(cardActionItem, card)}
            >{pluginText(cardActionItem.displayName)}</Button>)}
          </div>}
        </Card>)}
      </div>}
      </div>
    </Modal>
    {pendingCard && cardAction && <ConfirmDialog
      open
      title={"Use reset card"}
      busy={busy}
      confirmLabel={"Confirm use"}
      onCancel={() => setPendingCard(null)}
      onConfirm={() => {
        const card = pendingCard;
        setPendingCard(null);
        onCardAction(cardAction, card);
      }}
    >
      <p>{"Using this card consumes it immediately and cannot be undone. Continue?"}</p>
      <strong>{pluginText(pendingCard.title)}</strong>
    </ConfirmDialog>}
  </>;
}

function formatActionStatus(status: PluginResourceActionCard["status"]) {
  const value = typeof status === "string" ? status : pluginText(status);
  switch (value.toLowerCase()) {
    case "available": return "Ready";
    case "redeemed":
    case "used": return "Used";
    case "expired": return "Expired";
    default: return value;
  }
}

function formatActionDate(value: number) {
  return new Date(value).toLocaleString("en-US");
}

function StateBadge({ state }: { state: PluginResourceView["state"] }) {
  if (state.status === "cooling") {
    return <span className={styles.cooling} title={state.message ?? undefined}>{"Cooling down"}</span>;
  }
  if (state.status === "invalid") {
    return <span className={styles.invalid} title={state.message ?? undefined}>{"Invalid"}</span>;
  }
  return <span className={styles.ready}>{"Ready"}</span>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
