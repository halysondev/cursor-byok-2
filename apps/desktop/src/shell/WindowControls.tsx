import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Icon } from "../shared/ui/Icon";
import {
  windowCloseIcon,
  windowMaximizeIcon,
  windowMinimizeIcon,
  windowRestoreIcon,
} from "../shared/ui/icons";
import styles from "./WindowControls.module.scss";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const updateMaximized = async () => {
      const next = await appWindow.isMaximized();
      if (!disposed) setMaximized(next);
    };

    void updateMaximized();
    void appWindow.onResized(() => void updateMaximized()).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const appWindow = getCurrentWindow();
  const maximizeLabel = maximized ? "Restore window" : "Maximize window";

  return <div className={styles.root}>
    <button
      type="button"
      className={styles.button}
      aria-label={"Minimize window"}
      title={"Minimize window"}
      onClick={() => void appWindow.minimize()}
    >
      <Icon icon={windowMinimizeIcon} size="1.1em" />
    </button>
    <button
      type="button"
      className={styles.button}
      aria-label={maximizeLabel}
      title={maximizeLabel}
      onClick={() => void appWindow.toggleMaximize()}
    >
      <Icon icon={maximized ? windowRestoreIcon : windowMaximizeIcon} size="1.1em" />
    </button>
    <button
      type="button"
      className={[styles.button, styles.close].join(" ")}
      aria-label={"Close window"}
      title={"Close window"}
      onClick={() => void appWindow.close()}
    >
      <Icon icon={windowCloseIcon} size="1.1em" />
    </button>
  </div>;
}
