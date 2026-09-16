import type { ModelConnectivityResult } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { informationOutlineIcon } from "../../shared/ui/icons";
import styles from "./CursorModelTestResult.module.scss";

export type CursorModelTestState =
  | { status: "success"; result: ModelConnectivityResult }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export function CursorModelTestResult({ state, testing = false, compact = false }: {
  state?: CursorModelTestState;
  testing?: boolean;
  /** Compact badge form for list rows: renders nothing when untested; details go in the tooltip. */
  compact?: boolean;
}) {
  if (testing) {
    return compact
      ? <span className={`${styles.compact} ${styles.testing}`}>{"Testing…"}</span>
      : <div className={`${styles.root} ${styles.testing}`}><span className={styles.summary}>{"Testing…"}</span></div>;
  }
  if (!state) {
    return compact ? null : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{"Not tested"}</span></div>;
  }
  if (state.status === "cancelled") {
    return compact
      ? <span className={`${styles.compact} ${styles.idle}`}>{"Test cancelled"}</span>
      : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{"Test cancelled"}</span></div>;
  }

  const success = state.status === "success";
  const summary = success
    ? `Speed: ${formatSpeed(state.result.tokens_per_second)} tokens/s`
    : `Error: ${state.error}`;
  const detail = success
    ? `Speed ${formatSpeed(state.result.tokens_per_second)} tokens/s · first token ${state.result.first_valid_response_ms ?? "--"} ms · total ${state.result.duration_ms} ms · output ${state.result.output_tokens} tokens${state.result.tokens_estimated ? "(estimated)" : ""} · response: ${state.result.output || "--"}`
    : `Test failed: ${state.error}`;

  if (compact) {
    return <TooltipTrigger label={detail}>
      <span className={`${styles.compact} ${success ? styles.success : styles.error}`}>
        {success ? `${formatSpeed(state.result.tokens_per_second)} tokens/s` : "Test failed"}
        <Icon icon={informationOutlineIcon} size="1em" />
      </span>
    </TooltipTrigger>;
  }

  return <div className={`${styles.root} ${success ? styles.success : styles.error}`}>
    <span className={styles.summary}>{summary}</span>
    <TooltipTrigger label={detail}><button type="button" className={styles.details}>{"View details"}<Icon icon={informationOutlineIcon} size="1.1em" /></button></TooltipTrigger>
  </div>;
}

function formatSpeed(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}
