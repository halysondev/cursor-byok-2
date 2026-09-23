import { useEffect, useState } from "react";
import { api, type ProxySettings, type ProxySettingsInput, type StatisticsStorage, type StatisticsStorageScope, type TabSettings } from "../../shared/api";
import { PageContent } from "../../shell/layout/PageContent";
import { AccessTokenSettingsCard } from "./AccessTokenSettingsCard";
import { AppLifecycleSettingsCard } from "./AppLifecycleSettingsCard";
import { CommitSettingsCard } from "./CommitSettingsCard";
import { PricingSettingsCard } from "./PricingSettingsCard";
import { SubagentSettingsCard } from "./SubagentSettingsCard";
import { ProxySettingsCard } from "./ProxySettingsCard";
import { TabSettingsCard } from "./TabSettingsCard";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { themeOptions } from "../../shared/theme/theme";
import styles from "./SettingsPage.module.scss";

export function SettingsPage() {
  const { detailed, ports, theme } = useAppStore();
  const message = useMessage();
  const [proxyPort, setProxyPort] = useState(String(ports.proxy_port));
  const [servicePort, setServicePort] = useState(String(ports.service_port));
  const [editingPorts, setEditingPorts] = useState(false);
  const [savingPorts, setSavingPorts] = useState(false);
  const [storage, setStorage] = useState<StatisticsStorage | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearScope, setClearScope] = useState<StatisticsStorageScope>("details");
  const [clearing, setClearing] = useState(false);
  const [outboundProxy, setOutboundProxy] = useState<ProxySettings | null>(null);
  const [proxyDraft, setProxyDraft] = useState<ProxySettingsInput>({ mode: "default", address: "", auth_enabled: false, username: "", password: "" });
  const [editingProxy, setEditingProxy] = useState(false);
  const [savingProxy, setSavingProxy] = useState(false);
  const [tabSettings, setTabSettings] = useState<TabSettings | null>(null);
  const [tabDraft, setTabDraft] = useState<TabSettings>({ mode: "public", address: "" });
  const [editingTab, setEditingTab] = useState(false);
  const [savingTab, setSavingTab] = useState(false);
  useEffect(() => {
    const report = (cause: unknown) => message(cause instanceof Error ? cause.message : String(cause));
    void api.statisticsStorage().then(setStorage).catch(report);
    void api.proxySettings().then((next) => {
      setOutboundProxy(next);
      setProxyDraft({ mode: next.mode, address: next.address, auth_enabled: next.auth_enabled, username: next.username, password: "" });
    }).catch(report);
    void api.tabSettings().then((next) => {
      setTabSettings(next);
      setTabDraft(next);
    }).catch(report);
  }, [message]);
  useEffect(() => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
  }, [ports.proxy_port, ports.service_port]);

  const parsePort = (value: string, label: string) => {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`${label}${" must be an integer from 0 to 65535"}`);
    }
    return port;
  };
  const savePorts = async () => {
    try {
      const next = {
        proxy_port: parsePort(proxyPort, "Proxy port"),
        service_port: parsePort(servicePort, "Service port"),
      };
      setSavingPorts(true);
      if (await appStore.updatePorts(next)) {
        setEditingPorts(false);
        message("Port settings saved. Restart the app to apply them.", { duration: 4_000 });
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingPorts(false);
    }
  };
  const editPorts = () => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
    setEditingPorts(true);
  };
  const cancelPortEdit = () => {
    setProxyPort(String(ports.proxy_port));
    setServicePort(String(ports.service_port));
    setEditingPorts(false);
  };
  const clearStorage = async () => {
    try {
      setClearing(true);
      setStorage(await api.clearStatisticsStorage(clearScope));
      setConfirmClear(false);
      await appStore.refresh();
      message(clearScope === "all" ? "All statistics cleared" : "Detailed records cleared");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClearing(false);
    }
  };
  const editProxy = () => {
    if (!outboundProxy) return;
    setProxyDraft({ mode: outboundProxy.mode, address: outboundProxy.address, auth_enabled: outboundProxy.auth_enabled, username: outboundProxy.username, password: "" });
    setEditingProxy(true);
  };
  const cancelProxyEdit = () => {
    if (outboundProxy) {
      setProxyDraft({ mode: outboundProxy.mode, address: outboundProxy.address, auth_enabled: outboundProxy.auth_enabled, username: outboundProxy.username, password: "" });
    }
    setEditingProxy(false);
  };
  const saveProxy = async () => {
    try {
      setSavingProxy(true);
      const saved = await api.setProxySettings({ ...proxyDraft, password: proxyDraft.password || undefined });
      setOutboundProxy(saved);
      setProxyDraft({ mode: saved.mode, address: saved.address, auth_enabled: saved.auth_enabled, username: saved.username, password: "" });
      setEditingProxy(false);
      message("Proxy settings saved");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingProxy(false);
    }
  };
  const editTab = () => {
    if (!tabSettings) return;
    setTabDraft(tabSettings);
    setEditingTab(true);
  };
  const cancelTabEdit = () => {
    if (tabSettings) setTabDraft(tabSettings);
    setEditingTab(false);
  };
  const saveTab = async () => {
    try {
      if (tabDraft.mode === "custom" && !tabDraft.address.trim()) throw new Error("TAB service address is required");
      setSavingTab(true);
      const saved = await api.setTabSettings({ ...tabDraft, address: tabDraft.address.trim() });
      setTabSettings(saved);
      setTabDraft(saved);
      setEditingTab(false);
      message("TAB settings saved");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingTab(false);
    }
  };
  const clearTitle = clearScope === "all" ? "Clear all statistics?" : "Clear detailed records?";
  const clearDescription = clearScope === "all"
    ? "All call summaries, detailed content, and trace records will be deleted. Model configuration, CA, and application settings are unaffected. This action cannot be undone."
    : "Only request, response, and trace attachments are deleted; call summaries, metrics, and configuration are kept.";
  const content = (
    <div className={styles.page}>
      <TitledCard title={"Call observability"}>
        <div className={styles.settingRow}>
          <div>
            <strong>{"Detailed mode"}</strong>
            <small>
              {"Also store complete requests and streamed responses; by default only timing, status, and usage are stored."}
            </small>
          </div>
          <Checkbox
            label={"Detailed mode"}
            checked={detailed}
            onChange={(checked) => void appStore.updateDetailed(checked)}
          />
        </div>
      </TitledCard>
      <TitledCard title={"Port settings"} action={editingPorts ? (
        <div className={styles.cardActions}>
          <Button size="small" disabled={savingPorts} onClick={cancelPortEdit}>{"Cancel"}</Button>
          <Button variant="primary" size="small" disabled={savingPorts} onClick={() => void savePorts()}>{savingPorts ? "Saving…" : "Save"}</Button>
        </div>
      ) : (
        <button type="button" className={styles.textButton} onClick={editPorts}>{"Edit"}</button>
      )}>
        <div className={styles.portSettings}>
          <div className={styles.portFields}>
            {editingPorts ? <><FormField
              label={"Proxy port"}
              hint={"The local proxy port used by Cursor. Enter 0 to select a random port at startup."}
            >
              <TextInput
                type="number"
                min={0}
                max={65535}
                step={1}
                value={proxyPort}
                onChange={(event) => setProxyPort(event.target.value)}
              />
            </FormField>
            <FormField
              label={"Service port"}
              hint={"The local management service port used by the desktop frontend. Enter 0 to select a random port at startup."}
            >
              <TextInput
                type="number"
                min={0}
                max={65535}
                step={1}
                value={servicePort}
                onChange={(event) => setServicePort(event.target.value)}
              />
            </FormField></> : <>
              <div className={styles.portValue}><strong>{"Proxy port"}</strong><span>{ports.proxy_port}</span></div>
              <div className={styles.portValue}><strong>{"Service port"}</strong><span>{ports.service_port}</span></div>
            </>}
          </div>
          <div className={styles.portFooter}>
            <small>
              {"If a port is occupied, a new random port is selected and saved automatically. Restart the app after changing these settings."}
            </small>
          </div>
        </div>
      </TitledCard>
      <AccessTokenSettingsCard />
      <ProxySettingsCard settings={outboundProxy} draft={proxyDraft} editing={editingProxy} saving={savingProxy} onDraftChange={setProxyDraft} onEdit={editProxy} onCancel={cancelProxyEdit} onSave={() => void saveProxy()} />
      <TabSettingsCard settings={tabSettings} draft={tabDraft} editing={editingTab} saving={savingTab} onDraftChange={setTabDraft} onEdit={editTab} onCancel={cancelTabEdit} onSave={() => void saveTab()} />
      <CommitSettingsCard />
      <PricingSettingsCard />
      <SubagentSettingsCard />
      <AppLifecycleSettingsCard />
      <TitledCard title={"Theme"}>
        <div className={styles.themeActions}>
          {themeOptions.map(({ id }) => (
            <button
              className={theme === id ? styles.selected : ""}
              key={id}
              onClick={() => appStore.selectTheme(id)}
            >
              {id === "default-dark" ? "Default dark" : "Default light"}
            </button>
          ))}
        </div>
      </TitledCard>
      <TitledCard title={"Storage management"}>
        <div className={styles.storageRow}>
          <div>
            <strong>{"Statistics"}</strong>
            <small>
              {storage
                ? `${storage.call_count} calls · ${storage.trace_count} traces`
                : "Calculating…"}
            </small>
          </div>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => { setClearScope("details"); setConfirmClear(true); }}
          >
            {"Clear storage"}
          </button>
        </div>
      </TitledCard>
      <ConfirmDialog
        open={confirmClear}
        title={clearTitle}
        busy={clearing}
        cancelLabel={"Cancel"}
        confirmLabel={"Confirm clear"}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearStorage()}
      >
        <div className={styles.confirmContent}>
          <Select
            value={clearScope}
            ariaLabel={"Clear scope"}
            options={[
              { value: "details", label: "Only clear detailed records" },
              { value: "all", label: "Clear all statistics" },
            ]}
            onChange={(value) => setClearScope(value as StatisticsStorageScope)}
          />
          <small>{clearDescription}</small>
        </div>
      </ConfirmDialog>
    </div>
  );
  return <PageContent title={"Settings"} sections={[{ key: "settings", estimatedHeight: 1200, content }]} />;
}
