import { formatCompactInteger, formatInteger } from "../../../shared/utils/numberFormat";
import { useAppStore } from "../../../shared/store/appStore";
import { Icon } from "../../../shared/ui/Icon";
import { useTooltip, type TooltipAnchor } from "../../../shared/ui/Tooltip";
import { informationOutlineIcon } from "../../../shared/ui/icons";
import { CacheHitRateChart } from "./CacheHitRateChart";
import styles from "./HomeMetrics.module.scss";

export type HomeMetricsData = {
  llmCalls: number;
  successfulCalls: number;
  failedCalls: number;
  tokenUsage: number;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function formatMetricValue(value: number) {
  const full = formatInteger(value);
  const compact = formatCompactInteger(value);
  return full === compact ? full : `${full} (${compact})`;
}

function formatRate(value: number | null) {
  return value === null ? "No data" : `${(Math.max(0, Math.min(1, value)) * 100).toFixed(2)}%`;
}

function calculateRate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function priceTokens(tokens: number, pricePerMillion: number) {
  return (tokens / 1_000_000) * pricePerMillion;
}

function formatUSD(value: number) {
  return `$${value.toFixed(2)}`;
}

function elementAnchor(element: HTMLElement): TooltipAnchor {
  return {
    contextElement: element,
    getBoundingClientRect: () => element.getBoundingClientRect(),
  };
}

function InfoTooltip({ content }: { content: string }) {
  const { show, hide } = useTooltip();

  return <button
    type="button"
    className={styles.info}
    aria-label={"View instructions"}
    onMouseEnter={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onMouseLeave={hide}
    onFocus={(event) => show(elementAnchor(event.currentTarget), undefined, <div className={styles.tooltipText}>{content}</div>)}
    onBlur={hide}
  ><Icon icon={informationOutlineIcon} size="1.1em" /></button>;
}

export function HomeMetrics({ data, refreshVersion = 0 }: { data: HomeMetricsData; refreshVersion?: number }) {
  const { pricing } = useAppStore();
  const inputTokens = Math.max(0, data.promptTokens - data.cacheReadTokens - data.cacheWriteTokens);
  const outputTokens = Math.max(0, data.tokenUsage - data.promptTokens);
  const defaultCacheHitRate = calculateRate(data.cacheReadTokens, data.cacheReadTokens + inputTokens);
  const cacheReuseRate = calculateRate(
    data.cacheReadTokens,
    data.cacheReadTokens + data.cacheWriteTokens + inputTokens,
  );
  const successfulCallRate = calculateRate(data.successfulCalls, data.llmCalls);
  const costs = {
    input: priceTokens(inputTokens, pricing.input_per_million),
    output: priceTokens(outputTokens, pricing.output_per_million),
    cacheRead: priceTokens(data.cacheReadTokens, pricing.cache_read_per_million),
    cacheWrite: priceTokens(data.cacheWriteTokens, pricing.cache_write_per_million),
  };
  const totalCost = costs.input + costs.output + costs.cacheRead + costs.cacheWrite;
  const cacheCost = costs.cacheRead + costs.cacheWrite;
  const cacheTooltip = [
    `Current: ${formatRate(defaultCacheHitRate)}`,
    "Formula: cache read / (cache read + non-cached input)",
    `Default ${formatRate(defaultCacheHitRate)} / include creation ${formatRate(cacheReuseRate)}`,
  ].join("\n");
  const callsTooltip = [
    "Aggregated from historical LLM calls; in-progress calls are excluded.",
    "",
    `Total calls: ${formatMetricValue(data.llmCalls)}`,
    `Successful calls: ${formatMetricValue(data.successfulCalls)}`,
    `Failed calls: ${formatMetricValue(data.failedCalls)}`,
    `Success rate: ${formatRate(successfulCallRate)}`,
  ].join("\n");
  const tokensTooltip = [
    "Total request Tokens include the prompt and model output.",
    "",
    `Total requests: ${formatMetricValue(data.tokenUsage)}`,
    `Prompt: ${formatMetricValue(data.promptTokens)}`,
    `Estimated output: ${formatMetricValue(outputTokens)}`,
    `Non-cached input: ${formatMetricValue(inputTokens)}`,
    `Cache read: ${formatMetricValue(data.cacheReadTokens)}`,
    `Cache write: ${formatMetricValue(data.cacheWriteTokens)}`,
    "",
    "Cache reads and writes are included in prompt-side statistics.",
  ].join("\n");
  const costTooltip = [
    "Estimated using the configured token prices.",
    `Cache statistics policy: default (${formatRate(defaultCacheHitRate)})`,
    "",
    `Regular input: ${formatMetricValue(inputTokens)} × \$${pricing.input_per_million}/1M = ${formatUSD(costs.input)}`,
    `Model output: ${formatMetricValue(outputTokens)} × \$${pricing.output_per_million}/1M = ${formatUSD(costs.output)}`,
    `Cache read: ${formatMetricValue(data.cacheReadTokens)} × \$${pricing.cache_read_per_million}/1M = ${formatUSD(costs.cacheRead)}`,
    `Cache write: ${formatMetricValue(data.cacheWriteTokens)} × \$${pricing.cache_write_per_million}/1M = ${formatUSD(costs.cacheWrite)}`,
    "",
    `Total: ${formatUSD(totalCost)}`,
  ].join("\n");

  return <div className={styles.scroller}>
    <section className={styles.root} aria-label={"Call statistics"}>
      <article className={styles.metric}>
        <div className={styles.label}>{"Cache hit rate"}<InfoTooltip content={cacheTooltip} /></div>
        <CacheHitRateChart rate={defaultCacheHitRate ?? 0} animationKey={refreshVersion} />
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{"LLM calls"}<InfoTooltip content={callsTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatInteger(data.llmCalls)}>{formatCompactInteger(data.llmCalls)}</div>
          <div className={styles.secondary}>{`Successful ${formatCompactInteger(data.successfulCalls)} / failed ${formatCompactInteger(data.failedCalls)}`}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{"Token usage"}<InfoTooltip content={tokensTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatInteger(data.tokenUsage)}>{formatCompactInteger(data.tokenUsage)}</div>
          <div className={styles.secondary}>{`Prompt ${formatCompactInteger(data.promptTokens)}`}</div>
        </div>
      </article>
      <article className={styles.metric}>
        <div className={styles.label}>{"Estimated value"}<InfoTooltip content={costTooltip} /></div>
        <div className={styles.body}>
          <div className={styles.value} title={formatUSD(totalCost)}>{formatUSD(totalCost)}</div>
          <div className={styles.secondary}>{`Cache I/O ${formatUSD(cacheCost)}`}</div>
        </div>
      </article>
    </section>
  </div>;
}
