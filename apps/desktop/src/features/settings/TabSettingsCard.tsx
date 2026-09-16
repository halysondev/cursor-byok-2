import cursorIconUrl from "../../shared/assets/icons/cursor.svg";
import type { TabMode, TabSettings } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/FormControls";
import { Icon } from "../../shared/ui/Icon";
import { Select } from "../../shared/ui/Select";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./TabSettingsCard.module.scss";

export function TabSettingsCard({
  settings,
  draft,
  editing,
  saving,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  settings: TabSettings | null;
  draft: TabSettings;
  editing: boolean;
  saving: boolean;
  onDraftChange: (settings: TabSettings) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const modeLabel = (mode: TabMode) => {
    if (mode === "public") return "Use public service";
    if (mode === "direct") return "Direct";
    return "Custom";
  };
  const action = editing ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={saving} onClick={onCancel}>{"Cancel"}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</Button>
    </div>
  ) : (
    <button type="button" className={styles.headerAction} disabled={!settings} onClick={onEdit}>{"Edit"}</button>
  );

  return <TitledCard
    title={<div className={styles.title}><Icon src={cursorIconUrl} size="1.1em" /><span>{"TAB settings"}</span></div>}
    action={action}
  >
    <div className={styles.content}>
      {editing ? <>
        <div className={styles.row}>
          <div className={styles.description}>
            <strong>{"TAB connection"}</strong>
            <small>{"Choose how Cursor connects to TAB endpoints."}</small>
          </div>
          <div className={styles.control}><Select
            value={draft.mode}
            ariaLabel={"TAB connection"}
            options={[
              { value: "public", label: "Use public service" },
              { value: "direct", label: "Direct" },
              { value: "custom", label: "Custom" },
            ]}
            onChange={(mode) => onDraftChange({ ...draft, mode: mode as TabMode })}
          /></div>
        </div>
        {draft.mode === "custom" && <div className={styles.row}>
          <div className={styles.description}>
            <strong>{"TAB service address"}</strong>
            <small>{"The original endpoint path is appended to this service address."}</small>
          </div>
          <div className={styles.control}><TextInput
            value={draft.address}
            placeholder="https://tab.leokun.cn"
            aria-label={"TAB service address"}
            onChange={(event) => onDraftChange({ ...draft, address: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter") onSave(); }}
          /></div>
        </div>}
      </> : <>
        <div className={styles.row}>
          <strong>{"TAB connection"}</strong>
          <span className={styles.value}>{settings ? modeLabel(settings.mode) : "Loading…"}</span>
        </div>
        {settings?.mode === "custom" && <div className={styles.row}>
          <strong>{"TAB service address"}</strong>
          <span className={styles.value}>{settings.address}</span>
        </div>}
      </>}
    </div>
  </TitledCard>;
}
