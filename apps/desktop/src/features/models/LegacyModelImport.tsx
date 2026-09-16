import { useState, type ReactNode } from "react";
import { api, type LegacyModelImportPreview } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { useMessage } from "../../shared/ui/message";
import styles from "./LegacyModelImport.module.scss";

type LegacyModelImportControl = {
  busy: boolean;
  previewing: boolean;
  open: () => void;
};

export function LegacyModelImport({ children }: { children: (control: LegacyModelImportControl) => ReactNode }) {
  const message = useMessage();
  const [preview, setPreview] = useState<LegacyModelImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);

  const open = async () => {
    try {
      setPreviewing(true);
      setPreview(await api.previewV0049Models());
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setPreviewing(false);
    }
  };

  const confirm = async () => {
    try {
      setImporting(true);
      const result = await appStore.importV0049Models();
      if (!result) {
        const error = appStore.getSnapshot().error;
        if (error) message(error);
        return;
      }
      setPreview(null);
      message(result.imported > 0
        ? `Import complete: added ${result.imported} models and skipped ${result.skipped} existing models`
        : `All ${result.skipped} models in this configuration already exist; nothing needs to be imported`);
    } catch (cause) {
      message(errorText(cause));
    } finally {
      setImporting(false);
    }
  };

  return <>
    {children({ busy: previewing || importing, previewing, open: () => void open() })}
    <ConfirmDialog
      open={preview !== null}
      title={"Confirm legacy model configuration import"}
      busy={importing}
      wide
      cancelLabel={"Cancel"}
      confirmLabel={"Confirm import"}
      onCancel={() => setPreview(null)}
      onConfirm={() => void confirm()}
    >
      {preview && <div className={styles.content}>
        <div className={styles.source}>
          <strong>{"Configuration file"}</strong>
          <code>{preview.source}</code>
        </div>
        <div className={styles.counts}>
          <div><strong>{preview.total}</strong><small>{"Configured models"}</small></div>
          <div><strong>{preview.new_models}</strong><small>{"To add"}</small></div>
          <div><strong>{preview.existing_models}</strong><small>{"Existing"}</small></div>
        </div>
        <div className={styles.models}>
          {preview.models.map((model) => <div className={styles.model} key={model.model_hash}>
            <div>
              <strong>{model.display_name}</strong>
              <small>{model.model_id} · {model.type === "openai" ? "OpenAI" : "Anthropic"}</small>
            </div>
            <span className={model.existing ? styles.existing : styles.new}>
              {model.existing ? "Existing, skipped" : "New"}
            </span>
          </div>)}
        </div>
        <small className={styles.hint}>{"Importing the same configuration again will not create duplicate models. Existing models are skipped automatically."}</small>
      </div>}
    </ConfirmDialog>
  </>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
