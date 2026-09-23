import { useEffect, useState } from "react";
import { api, setStoredAccessToken, type AccessTokenInfo } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./AccessTokenSettingsCard.module.scss";

export function AccessTokenSettingsCard() {
  const message = useMessage();
  const [info, setInfo] = useState<AccessTokenInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    void api.accessToken()
      .then(setInfo)
      .catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [message]);

  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.token);
    } catch {
      try {
        await api.copyCursorText(info.token);
      } catch (cause) {
        message(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    }
    message("Copied");
  };

  const regenerate = async () => {
    try {
      setRegenerating(true);
      const next = await api.regenerateAccessToken();
      setStoredAccessToken(next.token);
      setInfo(next);
      setConfirming(false);
      message("Access token regenerated");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRegenerating(false);
    }
  };

  return <TitledCard title={"Access token"}>
    <div className={styles.content}>
      {info ? <>
        <TextInput
          readOnly
          className={styles.token}
          value={info.token}
          aria-label={"Access token"}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className={styles.actions}>
          <Button size="small" onClick={() => void copy()}>{"Copy"}</Button>
          <Button size="small" disabled={info.source === "environment"} onClick={() => setConfirming(true)}>{"Regenerate"}</Button>
        </div>
        <small className={styles.hint}>{info.source === "environment"
          ? "The token is pinned by the CURSOR_ACCESS_TOKEN environment variable and cannot be regenerated."
          : "This token is required for remote browser access."}</small>
      </> : <small className={styles.hint}>{"Loading…"}</small>}
    </div>
    <ConfirmDialog
      open={confirming}
      title={"Regenerate the access token?"}
      busy={regenerating}
      confirmLabel={"Regenerate"}
      onCancel={() => setConfirming(false)}
      onConfirm={() => void regenerate()}
    >
      <small className={styles.hint}>{"The old token stops working immediately; remote sessions using it must reconnect."}</small>
    </ConfirmDialog>
  </TitledCard>;
}
