import { useEffect, useState } from "react";
import type { TokenPricingSettings } from "../../shared/api";
import { appStore, DEFAULT_TOKEN_PRICING, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import styles from "./ProxySettingsCard.module.scss";

type PricingDraft = {
  input_per_million: string;
  output_per_million: string;
  cache_read_per_million: string;
  cache_write_per_million: string;
};

function toDraft(pricing: TokenPricingSettings): PricingDraft {
  return {
    input_per_million: String(pricing.input_per_million),
    output_per_million: String(pricing.output_per_million),
    cache_read_per_million: String(pricing.cache_read_per_million),
    cache_write_per_million: String(pricing.cache_write_per_million),
  };
}

function formatPrice(value: number) {
  return `$${value}`;
}

function parsePrice(value: string, label: string) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return price;
}

function toSettings(draft: PricingDraft): TokenPricingSettings {
  return {
    input_per_million: parsePrice(draft.input_per_million, "Input price"),
    output_per_million: parsePrice(draft.output_per_million, "Output price"),
    cache_read_per_million: parsePrice(draft.cache_read_per_million, "Cache read price"),
    cache_write_per_million: parsePrice(draft.cache_write_per_million, "Cache write price"),
  };
}

export function PricingSettingsCard() {
  const { pricing } = useAppStore();
  const message = useMessage();
  const [draft, setDraft] = useState<PricingDraft>(() => toDraft(pricing));
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(toDraft(pricing));
  }, [pricing, editing]);

  const edit = () => {
    setDraft(toDraft(pricing));
    setEditing(true);
  };

  const cancel = () => {
    setDraft(toDraft(pricing));
    setEditing(false);
  };

  const save = async () => {
    try {
      setSaving(true);
      const next = toSettings(draft);
      if (await appStore.updatePricingSettings(next)) {
        setEditing(false);
        message("Pricing settings saved");
      }
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const restoreDefault = () => {
    setDraft(toDraft(DEFAULT_TOKEN_PRICING));
  };

  const action = editing ? (
    <div className={styles.actionGroup}>
      <Button size="small" disabled={saving} onClick={restoreDefault}>{"Restore defaults"}</Button>
      <Button size="small" disabled={saving} onClick={cancel}>{"Cancel"}</Button>
      <Button variant="primary" size="small" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : (
    <button type="button" className={styles.headerAction} onClick={edit}>{"Edit"}</button>
  );

  return (
    <TitledCard title={"Token pricing"} action={action}>
      <div className={styles.content}>
        <small>{"Per-token unit prices used for home-page cost estimates, in USD per million tokens."}</small>
        {editing ? (
          <div className={styles.customFields}>
            <FormField label={"Input price ($/1M)"}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.input_per_million}
                onChange={(event) => setDraft({ ...draft, input_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={"Output price ($/1M)"}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.output_per_million}
                onChange={(event) => setDraft({ ...draft, output_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={"Cache read price ($/1M)"}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.cache_read_per_million}
                onChange={(event) => setDraft({ ...draft, cache_read_per_million: event.target.value })}
              />
            </FormField>
            <FormField label={"Cache write price ($/1M)"}>
              <TextInput
                type="number"
                min={0}
                step="any"
                value={draft.cache_write_per_million}
                onChange={(event) => setDraft({ ...draft, cache_write_per_million: event.target.value })}
              />
            </FormField>
          </div>
        ) : (
          <>
            <div className={styles.row}>
              <strong>{"Input price ($/1M)"}</strong>
              <span className={styles.value}>{formatPrice(pricing.input_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{"Output price ($/1M)"}</strong>
              <span className={styles.value}>{formatPrice(pricing.output_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{"Cache read price ($/1M)"}</strong>
              <span className={styles.value}>{formatPrice(pricing.cache_read_per_million)}</span>
            </div>
            <div className={styles.row}>
              <strong>{"Cache write price ($/1M)"}</strong>
              <span className={styles.value}>{formatPrice(pricing.cache_write_per_million)}</span>
            </div>
          </>
        )}
      </div>
    </TitledCard>
  );
}
