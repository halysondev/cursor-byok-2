import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { setStoredAccessToken } from "../shared/api";
import { appStore, useAppStore } from "../shared/store/appStore";
import { Button } from "../shared/ui/Button";
import { Card } from "../shared/ui/Card";
import { TextInput } from "../shared/ui/FormControls";
import styles from "./AccessTokenGate.module.scss";

/** Consumes the ?token= bootstrap parameter: stores it in localStorage and removes it from the URL. Called on the App's first render. */
export function consumeAccessTokenParam(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;
  setStoredAccessToken(token);
  url.searchParams.delete("token");
  window.history.replaceState(null, "", url);
}

export function AccessTokenGate() {
  const { accessTokenRequired } = useAppStore();
  const [token, setToken] = useState("");
  if (!accessTokenRequired) return null;
  const connect = (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setStoredAccessToken(value);
    appStore.setAccessTokenRequired(false);
    window.location.reload();
  };
  return createPortal(
    <div className={styles.mask}>
      <Card className={styles.card}>
        <form className={styles.form} onSubmit={connect}>
          <strong>{"Access token required"}</strong>
          <small>{"Remote access requires an access token. You can find it in the deployment log or on the settings page of a signed-in device."}</small>
          <TextInput
            type="password"
            value={token}
            autoFocus
            autoComplete="off"
            placeholder={"Access token"}
            aria-label={"Access token"}
            onChange={(event) => setToken(event.target.value)}
          />
          <Button variant="primary" type="submit" disabled={!token.trim()}>{"Connect"}</Button>
        </form>
      </Card>
    </div>,
    document.body,
  );
}
