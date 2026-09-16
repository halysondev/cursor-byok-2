import { useEffect, useState } from "react";
import {
  currentAppVersion,
  hasDockVisibilitySetting,
  hasNativeAppLifecycle,
  readAutostart,
  readDesktopSettings,
  writeAutostart,
  writeDockIconVisibility,
  writeSilentStart,
} from "../../shared/native/appLifecycle";
import { updateStore, useUpdateStore } from "../../shared/store/updateStore";
import { Button } from "../../shared/ui/Button";
import { Switch } from "../../shared/ui/Switch";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./AppLifecycleSettingsCard.module.scss";

export function AppLifecycleSettingsCard() {
  const message = useMessage();
  const native = hasNativeAppLifecycle();
  const dockVisibilitySetting = hasDockVisibilitySetting();
  const { availableVersion, checking, installing } = useUpdateStore();
  const [version, setVersion] = useState("…");
  const [autostart, setAutostart] = useState(false);
  const [loadingAutostart, setLoadingAutostart] = useState(native);
  const [silentStart, setSilentStart] = useState(false);
  const [dockIconVisible, setDockIconVisible] = useState(true);
  const [loadingDesktopSettings, setLoadingDesktopSettings] = useState(native);

  useEffect(() => {
    let disposed = false;
    void currentAppVersion().then((next) => { if (!disposed) setVersion(next); });
    if (native) {
      void readAutostart()
        .then((enabled) => { if (!disposed) setAutostart(enabled); })
        .catch((cause) => message(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => { if (!disposed) setLoadingAutostart(false); });
      void readDesktopSettings()
        .then((settings) => {
          if (disposed) return;
          setSilentStart(settings.silent_start);
          setDockIconVisible(settings.show_dock_icon);
        })
        .catch(() => {})
        .finally(() => {
          if (disposed) return;
          setLoadingDesktopSettings(false);
        });
    }
    return () => { disposed = true; };
  }, [message, native]);

  const toggleAutostart = async (enabled: boolean) => {
    try {
      setLoadingAutostart(true);
      await writeAutostart(enabled);
      setAutostart(await readAutostart());
      message(enabled ? "Launch at login enabled" : "Launch at login disabled");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingAutostart(false);
    }
  };

  const toggleSilentStart = async (enabled: boolean) => {
    try {
      setLoadingDesktopSettings(true);
      await writeSilentStart(enabled);
      setSilentStart(enabled);
      message(enabled ? "Silent start enabled" : "Silent start disabled");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingDesktopSettings(false);
    }
  };

  const toggleDockIcon = async (visible: boolean) => {
    try {
      setLoadingDesktopSettings(true);
      await writeDockIconVisibility(visible);
      setDockIconVisible(visible);
      message(visible ? "Dock icon shown" : "Dock icon hidden");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingDesktopSettings(false);
    }
  };

  const checkUpdate = async () => {
    try {
      const nextVersion = await updateStore.check();
      message(nextVersion ? `Version ${nextVersion} is available` : "You're up to date");
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      message(`Failed to check for updates: ${error}`);
    }
  };

  const updateNow = async () => {
    try {
      await updateStore.install();
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      message(`Failed to install update: ${error}`);
    }
  };

  return <TitledCard title={"Application"}>
    <div className={styles.row}>
      <div>
        <strong>{"Launch at login"}</strong>
        <small>{"Start Cursor BYOK automatically after signing in."}</small>
      </div>
      <Switch
        checked={autostart}
        disabled={!native || loadingAutostart}
        label={"Launch at login"}
        onChange={(enabled) => void toggleAutostart(enabled)}
      />
    </div>
    {autostart && <div className={styles.row}>
      <div>
        <strong>{"Silent start"}</strong>
        <small>{"Hide the main window on startup and keep only the tray icon."}</small>
      </div>
      <Switch
        checked={silentStart}
        disabled={!native || loadingDesktopSettings}
        label={"Silent start"}
        onChange={(enabled) => void toggleSilentStart(enabled)}
      />
    </div>}
    {dockVisibilitySetting && <div className={styles.row}>
      <div>
        <strong>{"Show in Dock"}</strong>
        <small>{"Hide the Dock icon when disabled. You can still open the app from the menu bar icon."}</small>
      </div>
      <Switch
        checked={dockIconVisible}
        disabled={loadingDesktopSettings}
        label={"Show in Dock"}
        onChange={(visible) => void toggleDockIcon(visible)}
      />
    </div>}
    <div className={styles.row}>
      <div>
        <strong>{"Software updates"}</strong>
        <small>{availableVersion
          ? `Version ${availableVersion} is ready to install`
          : `Current version ${version}`}</small>
      </div>
      {availableVersion
        ? <Button size="small" variant="primary" disabled={installing} onClick={() => void updateNow()}>
            {installing ? "Installing…" : "Download and install"}
            <span className={styles.updateDot} aria-hidden="true" />
          </Button>
        : <Button size="small" disabled={!native || checking} onClick={() => void checkUpdate()}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>}
    </div>
  </TitledCard>;
}
