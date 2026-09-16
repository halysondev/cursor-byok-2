import type { CallDetail } from "../../shared/api";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Tabs, type TabItem } from "../../shared/ui/Tabs";
import styles from "./CallDetails.module.scss";

const show = (value: string | number | null) => value ?? "-";
const timing = (value: number | null) => value == null ? "-" : `${value} ms`;

export function CallDetails({ detail }: { detail: CallDetail }) {
  const { call, request, response_chunks: chunks, cursor_trace: cursorTrace } = detail;
  const responseBody = chunks.map((chunk) => chunk.data).join("");
  const responseBytes = chunks.reduce((total, chunk) => total + chunk.byte_count, 0);
  const fields: Array<[string, string | number]> = [
    ["Call ID", call.call_id],
    ["Call type", call.call_kind === "cursor_official" ? "Cursor official" : "LLM"],
    ["Route", call.route === "cursor_official" ? "Cursor official" : "BYOK"],
    ["Run ID", call.run_id],
    ["Conversation ID", call.conversation_id],
    ["Provider call sequence", call.provider_call_index],
    ["Model Hash", show(call.model_hash)],
    ["Provider type", call.provider_type],
    ["Provider URL", call.provider_url],
    ["Final request type", call.request_type],
    ["Final request URL", call.request_url],
    ["Model ID", call.model_id],
    ["Display name", call.display_name],
    ["Reasoning effort", show(call.reasoning_effort)],
    ["Fast", call.fast == null ? "-" : call.fast ? "Yes" : "No"],
    ["Status", call.status],
    ["Finish Reason", show(call.finish_reason)],
    ["HTTP Status", show(call.http_status)],
    ["Created At", `${call.created_at_ms} · ${new Date(call.created_at_ms).toLocaleString()}`],
    ["Duration", timing(call.duration_ms)],
    ["TTFB", timing(call.ttfb_ms)],
    ["TTFR", timing(call.ttfr_ms)],
    ["TTFT", timing(call.ttft_ms)],
    ["Input Token", show(call.input_tokens)],
    ["Output Token", show(call.output_tokens)],
    ["Total Token", show(call.total_tokens)],
    ["Cache Read Token", show(call.cache_read_tokens)],
    ["Cache Write Token", show(call.cache_write_tokens)],
    ["Reasoning Token", show(call.reasoning_tokens)],
    ["Messages", call.message_count],
    ["Tools", call.tool_count],
    ["Detailed records", call.detailed ? "Yes" : "No"],
    ["Error Kind", show(call.error_kind)],
    ["Error Message", show(call.error_message)],
  ];

  const tabs: TabItem[] = [
    { value: "call", label: "Call information", content: <section>
      <dl className={styles.details}>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
    </section> },
    { value: "request", label: "Request", content: <section>
      {request ? <>
        <div className={styles.meta}>{"Bytes"}: {request.byte_count}</div>
        <h4>{"Request headers"}</h4><JsonEditor ariaLabel={"Request headers"} value={JSON.stringify(request.headers)} readOnly />
        <h4>{"Request body"}</h4><JsonEditor ariaLabel={"Request body"} value={JSON.stringify(request.body)} readOnly detail />
      </> : <div className={styles.empty}>{"Request content was not recorded. Enable detailed records and try again."}</div>}
    </section> },
    { value: "response", label: "Response stream", content: <section>
      {chunks.length > 0 ? <>
        <div className={styles.meta}>{"Chunks"}: {chunks.length} · {"Bytes"}: {responseBytes}</div>
        <JsonEditor ariaLabel={"Response stream"} value={responseBody} readOnly detail />
      </> : <div className={styles.empty}>{"Response content was not recorded. Enable detailed records and try again."}</div>}
    </section> },
  ];

  if (cursorTrace) tabs.push({ value: "cursor-trace", label: "Cursor tracing", content: <section>
      <div className={styles.meta}>
        Request ID: {cursorTrace.trace.request_id} · {"Artifacts"}: {cursorTrace.artifacts.length}
      </div>
      <JsonEditor
        ariaLabel={"Cursor tracing"}
        value={JSON.stringify({ trace: cursorTrace.trace, artifacts: cursorTrace.artifacts })}
        readOnly
        detail
      />
    </section> });

  return <div className={styles.root}><Tabs items={tabs} /></div>;
}
