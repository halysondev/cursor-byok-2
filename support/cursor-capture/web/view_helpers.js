// view_helpers.js provides the formatting, escaping, and copy-text helpers used by the debugger UI.

// renderDecodeError converts a decode error into a safe notice fragment.
export function renderDecodeError(error) {
  return error ? `<div class="frame-error">${escapeHTML(error)}</div>` : "";
}

// renderTruncated renders the notice shown when a body was truncated.
export function renderTruncated(truncated) {
  return truncated ? `<div class="truncated-notice">${escapeHTML("Raw body reached the local capture limit; forwarded data was not truncated")}</div>` : "";
}

// formatState converts a capture state into display text.
export function formatState(value) {
  return {
    pending: "Pending",
    streaming: "Streaming",
    completed: "Completed",
    error: "Error",
  }[value] || value || "-";
}

// currentCopyText extracts the copyable payload text for the current tab.
export function currentCopyText(side, state) {
  const payload = state.selected?.[side];
  if (!payload) return "";
  const tab = state.tabs[side];
  if (tab === "headers") return (payload.headers || []).map((item) => `${item.name}: ${item.value}`).join("\n");
  if (tab === "raw") return payload.rawHex || "";
  if (tab === "frames") return (payload.frames || []).map((frame) => frame.json || frame.rawHex || frame.error || "").join("\n\n");
  return payload.decodedJson || "";
}

// formatHex formats a hex payload into lines for the debug view.
export function formatHex(value) {
  const hex = String(value || "").replace(/[^0-9a-f]/gi, "");
  const lines = [];
  for (let index = 0; index < hex.length; index += 32) {
    const chunk = hex.slice(index, index + 32);
    const bytes = chunk.match(/.{1,2}/g) || [];
    lines.push(`${(index / 2).toString(16).padStart(8, "0")}  ${bytes.join(" ")}`);
  }
  return lines.join("\n");
}

// formatBytes formats a byte count into a human-readable unit.
export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// formatDuration formats a millisecond duration into a human-readable unit.
export function formatDuration(value) {
  const milliseconds = Number(value || 0);
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

// escapeHTML escapes user or network input so it cannot form HTML when inserted into the page.
export function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
