import type { LlmCall } from "../../shared/api";
import controls from "../../shared/ui/Controls.module.scss";
import { DataTable, type DataTableColumn } from "../../shared/ui/DataTable";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { eyeIcon } from "../../shared/ui/icons";
import styles from "./CallTable.module.scss";

const value = (input: string | number | null) => input ?? "-";
const milliseconds = (input: number | null) => input == null ? "-" : `${input} ms`;

export function CallTable({ calls, onDetails }: { calls: LlmCall[]; onDetails: (call: LlmCall) => void }) {
  const columns: DataTableColumn<LlmCall>[] = [
    {
      key: "status",
      header: "Status",
      render: (call) => (
        <span
          className={[styles.status, styles[call.status]]
            .filter(Boolean)
            .join(" ")}
        >
          {call.status}
        </span>
      ),
    },

    {
      key: "display_name",
      header: "Display name",
      render: (call) => call.display_name,
      title: (call) => call.display_name,
    },
    {
      key: "created_at",
      header: "Time",
      render: (call) => new Date(call.created_at_ms).toLocaleString(),
    },
    {
      key: "model_id",
      header: "Model name",
      render: (call) => call.model_id,
      title: (call) => call.model_id,
    },
    {
      key: "reasoning_effort",
      header: "Reasoning effort",
      render: (call) => value(call.reasoning_effort),
    },
    {
      key: "fast",
      header: "Fast",
      render: (call) => call.fast == null ? "-" : call.fast ? "Yes" : "No",
    },

    {
      key: "call_kind",
      header: "Call type",
      render: (call) =>
        call.call_kind === "cursor_official" ? "Cursor official" : "LLM",
    },
    {
      key: "route",
      header: "Route",
      render: (call) =>
        call.route === "cursor_official" ? "Cursor official" : "BYOK",
    },

    // { key: "model_hash", header: "Model Hash", render: (call) => value(call.model_hash), title: (call) => call.model_hash ?? undefined },
    // { key: "provider_type", header: "Provider type", render: (call) => call.provider_type },
    // { key: "provider_url", header: "Provider URL", render: (call) => call.provider_url, title: (call) => call.provider_url },
    // { key: "request_type", header: "Final request type", render: (call) => call.request_type },
    // { key: "request_url", header: "Final request URL", render: (call) => call.request_url, title: (call) => call.request_url },
    {
      key: "finish_reason",
      header: "Finish Reason",
      render: (call) => value(call.finish_reason),
    },
    { key: "http", header: "HTTP", render: (call) => value(call.http_status) },
    {
      key: "duration",
      header: "Duration",
      render: (call) => milliseconds(call.duration_ms),
    },
    {
      key: "ttfb",
      header: "TTFB",
      render: (call) => milliseconds(call.ttfb_ms),
    },
    {
      key: "ttfr",
      header: "TTFR",
      render: (call) => milliseconds(call.ttfr_ms),
    },
    {
      key: "ttft",
      header: "TTFT",
      render: (call) => milliseconds(call.ttft_ms),
    },
    {
      key: "input_tokens",
      header: "Input Token",
      render: (call) => value(call.input_tokens),
    },
    {
      key: "output_tokens",
      header: "Output Token",
      render: (call) => value(call.output_tokens),
    },
    {
      key: "total_tokens",
      header: "Total Token",
      render: (call) => value(call.total_tokens),
    },
    {
      key: "cache_read",
      header: "Cache Read",
      render: (call) => value(call.cache_read_tokens),
    },
    {
      key: "cache_write",
      header: "Cache Write",
      render: (call) => value(call.cache_write_tokens),
    },
    {
      key: "reasoning_tokens",
      header: "Reasoning Token",
      render: (call) => value(call.reasoning_tokens),
    },
    {
      key: "message_count",
      header: "Messages",
      render: (call) => call.message_count,
    },
    {
      key: "tool_count",
      header: "Tools",
      render: (call) => call.tool_count,
    },
    {
      key: "detailed",
      header: "Detailed records",
      render: (call) => (call.detailed ? "Yes" : "No"),
    },

    {
      key: "error_kind",
      header: "Error Kind",
      render: (call) => value(call.error_kind),
      title: (call) => call.error_kind ?? undefined,
    },
    {
      key: "error_message",
      header: "Error Message",
      render: (call) => value(call.error_message),
      title: (call) => call.error_message ?? undefined,
    },
    {
      key: "call_id",
      header: "Call ID",
      render: (call) => call.call_id,
      title: (call) => call.call_id,
    },
    {
      key: "run_id",
      header: "Run ID",
      render: (call) => call.run_id,
      title: (call) => call.run_id,
    },
    {
      key: "conversation_id",
      header: "Conversation ID",
      render: (call) => call.conversation_id,
      title: (call) => call.conversation_id,
    },
    {
      key: "call_index",
      header: "Call Index",
      render: (call) => call.provider_call_index,
    },
    {
      key: "actions",
      header: "Actions",
      sticky: "right",
      render: (call) => (
        <TooltipTrigger label={"View details"}>
          <button
            className={controls.iconButton}
            aria-label={"View details"}
            onClick={() => onDetails(call)}
          >
            <Icon icon={eyeIcon} size="1.1em" />
          </button>
        </TooltipTrigger>
      ),
    },
  ];
  return <DataTable rows={calls} columns={columns} rowKey={(call) => call.call_id} minWidth={4180} />;
}
