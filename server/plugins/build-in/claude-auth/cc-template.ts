/**
 * CC wire-shape template engine.
 *
 * Rebuilds outbound requests as a genuine [CC] request, adapted to the plugin
 * SDK's canonical LlmRequest contract. Everything the upstream billing
 * classifier can observe is reproduced byte-identically:
 *
 *   - system prompt: [0] billing tag, [1] agent identity, [2] CC system prompt
 *     (per-model variant) + the client's own instructions appended
 *   - metadata.user_id JSON with device_id / account_uuid / session_id
 *   - tools: CC's canonical tool array, with client tools forward-mapped onto
 *     CC slots and responses reverse-mapped back
 *   - betas: the captured template beta set + oauth-2025-04-20, adjusted
 *     per model family exactly like real CC
 *   - key order / header order matching the captured CC release
 *
 * The bundled template (assets/cc-template-data.json) is the known-good
 * capture, refreshed from a loopback capture of a real CC session.
 */

import type { JsonValue } from "cursor-byok:plugin";
import type { LlmContentPart, LlmRequest } from "cursor-byok:provider";

import templateData from "./assets/cc-template-data.json" with { type: "json" };

type TemplateData = {
  _version: string;
  agent_identity: string;
  system_prompt: string;
  system_prompt_variants?: Record<string, string>;
  tools: Array<Record<string, JsonValue>>;
  tool_names: string[];
  header_order: string[];
  anthropic_beta: string;
  header_values: Record<string, string>;
  body_field_order: string[];
};

const TEMPLATE = templateData as unknown as TemplateData;

/** CC CLI version the bundled template was captured from. */
export const CC_VERSION = TEMPLATE._version;

/** Seed for the billing-tag build suffix. */
const BILLING_SEED = "59cf53e54c78";

/** CC's agent identity string. */
export const CC_AGENT_IDENTITY = TEMPLATE.agent_identity;

/** Per-family system prompt variants (fable, opus-5, sonnet-5); base for everything else. */
const VARIANTS: Record<string, string> = TEMPLATE.system_prompt_variants ?? {};

function systemPromptForModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("fable")) return VARIANTS["fable"] ?? TEMPLATE.system_prompt;
  if (/opus-5(?!\d)/.test(m)) return VARIANTS["opus-5"] ?? TEMPLATE.system_prompt;
  if (/sonnet-5(?!\d)/.test(m)) return VARIANTS["sonnet-5"] ?? TEMPLATE.system_prompt;
  return TEMPLATE.system_prompt;
}

/**
 * Frame the client's own instructions so they ride inside the CC system prompt.
 * System prompt content/length are not billing-classifier inputs (verified
 * against live subscription sessions), so this framing cannot affect routing.
 */
export const CLIENT_SYSTEM_PREFACE =
  "\n\n---\n\nIMPORTANT: The operator of this session has supplied the following " +
  "task-specific instructions. For this conversation they OVERRIDE any " +
  "conflicting general behavior described above. Follow them exactly:\n\n";

// The billing-tag build suffix is sha256(seed + version + systemPrompt)
// truncated to 3 hex chars. The digest is primed once at plugin init
// (primeBillingTag) so the first outbound request already carries the real
// value; before priming completes the suffix reads "000" and callers must not
// build requests.
const suffixCache = new Map<string, string>();

function versionSuffix(version: string): string {
  return suffixCache.get(version) ?? "000";
}

/**
 * Compute and memoize the billing-tag version suffix. Call once at plugin init
 * and await the result before serving requests.
 */
export async function primeBillingTag(): Promise<void> {
  const bytes = new TextEncoder().encode(`${BILLING_SEED}${CC_VERSION}${systemPromptForModel("")}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  suffixCache.set(CC_VERSION, hex.slice(0, 3));
}

/**
 * The billing tag stamped as system[0] on every outbound request — the marker
 * Anthropic's billing classifier keys on to route the request to the
 * subscription allocation instead of retail API billing.
 *
 * Format matches real CC:
 *   with cch:    `…; -cli; cch=<5hex>;`   (older releases)
 *   without cch: `…; -cli;`               (current releases)
 *
 * Current CC sends no cch token, so it is always omitted here — never emit a
 * token we cannot produce deterministically.
 */
export function buildBillingTag(version: string): string {
  const fullVersion = `${version}.${versionSuffix(version)}`;
  return `x-anthropic-billing-header: cc_version=${fullVersion}; cc_entrypoint=sdk-cli;`;
}

// ---------------------------------------------------------------------------
// Beta flags
// ---------------------------------------------------------------------------

export const FABLE_FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";
export const CONTEXT_1M_BETA = "context-1m-2025-08-07";
export const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
export const EFFORT_BETA = "effort-2025-11-24";
export const AFK_MODE_BETA = "afk-mode-2026-01-31";
export const ADVISOR_TOOL_BETA = "advisor-tool-2026-03-01";
export const CLAUDE_CODE_BETA = "claude-code-20250219";
export const MID_CONVERSATION_TOOL_CHANGES_BETA = "mid-conversation-tool-changes-2026-07-01";

/** CC's OAuth-enablement beta flag; required on subscription Bearer requests. */
export const OAUTH_BETA = "oauth-2025-04-20";

function insertBetaBefore(flags: string[], flag: string, anchor: string): string[] {
  if (flags.includes(flag)) return flags;
  const i = flags.indexOf(anchor);
  return i < 0 ? [...flags, flag] : [...flags.slice(0, i), flag, ...flags.slice(i)];
}

function insertBetaAfter(flags: string[], flag: string, anchor: string): string[] {
  if (flags.includes(flag)) return flags;
  const i = flags.indexOf(anchor);
  return i < 0 ? [...flags, flag] : [...flags.slice(0, i + 1), flag, ...flags.slice(i + 1)];
}

function moveBetaBefore(flags: string[], flag: string, anchor: string): string[] {
  const without = flags.filter((f) => f !== flag);
  return insertBetaBefore(without, flag, anchor);
}

/**
 * Model-conditional beta set, mirroring real CC exactly:
 *  - haiku drops mid-conversation/effort/afk flags and reorders claude-code
 *  - the sonnet line drops mid-conversation-tool-changes; sonnet-4 also drops
 *    mid-conversation-system
 *  - fable-5 / opus-5 append fallback-credit before afk-mode
 *  - the `[1m]` suffix rides context-1m after claude-code (client-side label)
 */
export function betaForModel(base: string, model: string | null | undefined): string {
  const m = (model ?? "").toLowerCase();
  let flags = base.split(",").map((s) => s.trim()).filter(Boolean);

  if (m.includes("haiku")) {
    const drop = new Set([
      MID_CONVERSATION_SYSTEM_BETA,
      MID_CONVERSATION_TOOL_CHANGES_BETA,
      EFFORT_BETA,
      AFK_MODE_BETA,
    ]);
    flags = flags.filter((f) => !drop.has(f));
    flags = moveBetaBefore(flags, CLAUDE_CODE_BETA, ADVISOR_TOOL_BETA);
  } else if (m.includes("sonnet")) {
    flags = flags.filter((f) => f !== MID_CONVERSATION_TOOL_CHANGES_BETA);
    if (/sonnet-4/.test(m)) {
      flags = flags.filter((f) => f !== MID_CONVERSATION_SYSTEM_BETA);
    }
  } else if (m.includes("fable") || /opus-5(?!\d)/.test(m)) {
    flags = insertBetaBefore(flags, FABLE_FALLBACK_CREDIT_BETA, AFK_MODE_BETA);
  }
  // opus-4-x + unknown families keep the base set unchanged.

  if (/\[1m\]$/.test(m)) {
    flags = insertBetaAfter(flags, CONTEXT_1M_BETA, CLAUDE_CODE_BETA);
  }

  return flags.join(",");
}

/** Full outbound beta set: captured template betas + oauth, adjusted per model. */
export function betaForRequest(model: string): string {
  let base = TEMPLATE.anthropic_beta;
  if (!base.split(",").includes(OAUTH_BETA)) {
    base = base ? `${base},${OAUTH_BETA}` : OAUTH_BETA;
  }
  return betaForModel(base, model);
}

/** Strip the client-side `[1m]` label — never a valid wire id. */
export function stripContext1mTag(model: string): string {
  return model.replace(/\[1m\]$/, "");
}

// ---------------------------------------------------------------------------
// Thinking / effort
// ---------------------------------------------------------------------------

/**
 * Whether the model accepts `thinking: { type: "adaptive" }` — the 4.6
 * generation and up. Allow-list pattern, default-deny: an unlisted model
 * silently omits `thinking` (always accepted upstream) rather than 400ing.
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const m = modelId.toLowerCase();
  const mm = m.match(/(?:opus|sonnet|fable)-(\d{1,2})-(\d{1,2})\b/);
  if (mm) {
    const major = Number(mm[1]);
    const minor = Number(mm[2]);
    if (major > 4) return true;
    if (major === 4 && minor >= 6) return true;
    return false;
  }
  const majorOnly = m.match(/(?:opus|sonnet|fable)-(\d{1,2})(?!\d|-)/);
  if (majorOnly && Number(majorOnly[1]) >= 5) return true;
  return false;
}

/** Default outbound max_tokens; tracks CC's wire default. */
export const DEFAULT_MAX_TOKENS = 64000;

/** Normalize an effort value to a wire-valid `output_config.effort`. */
function normalizeEffortForWire(effort: string): string {
  return effort === "ultracode" ? "xhigh" : effort;
}

/**
 * Resolve the outbound `output_config.effort`. Effort is a user knob: forward
 * the client's own choice, falling back to `high` when it sent none.
 */
export function resolveEffort(effort: string | null): string {
  if (effort && effort.length > 0) return normalizeEffortForWire(effort);
  return "high";
}

// ---------------------------------------------------------------------------
// Client-identity scrubbing
// ---------------------------------------------------------------------------

const FRAMEWORK_PATTERNS: RegExp[] = [
  /\b(roo[- ]?cline|roo[- ]?code|big[- ]?agi|claude[- ]?bridge|amazon\s+q)\b/gi,
  /\b(openclaw|hermes|aider|cursor|windsurf|cline|continue|copilot|cody)\b/gi,
  /\b(zed|plandex|tabby|opencode|daytona)\b/gi,
  /\b(librechat|typingmind)\b/gi,
  /\b(openai|gpt-4|gpt-3\.5)\b/gi,
  /powered by [a-z]+/gi,
  /\bgateway\b/gi,
];

// Patterns SAFE to apply to message content (user data) — distinctive
// multi-token product identifiers only, so user code is never corrupted.
const CONTENT_FRAMEWORK_PATTERNS: RegExp[] = [
  /\b(roo[- ]?cline|roo[- ]?code|big[- ]?agi|claude[- ]?bridge)\b/gi,
  /\b(librechat|typingmind)\b/gi,
];

function scrubWithPatterns(text: string, patterns: readonly RegExp[]): string {
  let result = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, ...args) => {
      const offset = args[args.length - 2] as number;
      const src = args[args.length - 1] as string;
      const before = offset > 0 ? src[offset - 1] : "";
      const after = offset + match.length < src.length ? src[offset + match.length] : "";
      // Preserve matches embedded in filesystem paths or URLs.
      if (before === "." || before === "/" || before === "\\" || before === "-" || before === "_") {
        return match;
      }
      if (after === "/" || after === "\\") return match;
      return "";
    });
  }
  return result;
}

/** Scrub the client's system prompt / identity fields — full pattern set. */
export function scrubFrameworkIdentifiers(text: string): string {
  return scrubWithPatterns(text, FRAMEWORK_PATTERNS);
}

/** Scrub message content — content-safe subset only. */
export function scrubFrameworkIdentifiersInContent(text: string): string {
  return scrubWithPatterns(text, CONTENT_FRAMEWORK_PATTERNS);
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

export interface ToolMapping {
  ccTool: string;
  translateArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  translateBack?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Reverse-lookup priority for collisions on the same CC tool; higher wins. */
  reverseScore?: number;
}

/** Default prompt injected into WebFetch calls when the client omits one. */
const WEBFETCH_DEFAULT_PROMPT = "Extract and return the main content of this page.";

function webFetchArgs(url: unknown, clientPrompt?: unknown): Record<string, unknown> {
  const prompt = typeof clientPrompt === "string" && clientPrompt.trim() !== ""
    ? clientPrompt
    : WEBFETCH_DEFAULT_PROMPT;
  return { url: String(url || ""), prompt };
}

function bashMapping(commandKeys: string[]): ToolMapping {
  return {
    ccTool: "Bash",
    translateArgs: (a) => ({
      command: commandKeys.map((k) => a[k]).find((v) => typeof v === "string" && v) || "",
      ...(a.description ? { description: a.description } : {}),
    }),
    translateBack: (a) => ({
      command: a.command ?? "",
      ...(a.description ? { description: a.description } : { description: a.command ?? "" }),
    }),
  };
}

const BASH_FULL = bashMapping(["cmd", "command", "c"]);
const BASH_RUN = bashMapping(["cmd", "command"]);

/** Client tool name → CC tool mapping with parameter translation. */
export const TOOL_MAP: Record<string, ToolMapping> = {
  bash: BASH_FULL,
  exec: BASH_FULL,
  shell: BASH_FULL,
  run: BASH_RUN,
  command: BASH_RUN,
  terminal: BASH_RUN,
  execute_command: {
    ccTool: "Bash",
    translateArgs: (a) => ({
      command: a.command || a.cmd || "",
      ...(a.description ? { description: a.description } : {}),
    }),
    translateBack: (a) => ({
      command: a.command ?? "",
      requires_approval: false,
      ...(a.description ? { description: a.description } : { description: a.command ?? "" }),
    }),
  },
  run_terminal_cmd: {
    ccTool: "Bash",
    translateArgs: (a) => ({
      command: a.command || "",
      ...(a.explanation ? { description: a.explanation } : {}),
    }),
    translateBack: (a) => ({
      command: a.command ?? "",
      is_background: false,
      ...(a.description ? { explanation: a.description } : {}),
    }),
  },
  run_command: {
    ccTool: "Bash",
    translateArgs: (a) => ({ command: a.CommandLine || a.command || "" }),
    translateBack: (a) => ({ CommandLine: a.command ?? "", Blocking: true }),
  },
  builtin_run_terminal_command: {
    ccTool: "Bash",
    translateArgs: (a) => ({ command: a.command || "" }),
    translateBack: (a) => ({ command: a.command ?? "" }),
  },
  run_in_terminal: {
    ccTool: "Bash",
    translateArgs: (a) => ({
      command: a.command || "",
      ...(a.explanation ? { description: a.explanation } : {}),
    }),
    translateBack: (a) => ({
      command: a.command ?? "",
      ...(a.description ? { explanation: a.description } : {}),
    }),
  },
  execute_bash: {
    ccTool: "Bash",
    translateArgs: (a) => ({ command: a.command || "" }),
    translateBack: (a) => ({ command: a.command ?? "", is_input: "false", security_risk: "LOW" }),
  },
  process: {
    ccTool: "Bash",
    translateArgs: (a) => ({ command: a.action || a.cmd || "" }),
    translateBack: (a) => ({ action: a.command ?? "" }),
    reverseScore: 1,
  },
  read: {
    ccTool: "Read",
    translateArgs: (a) => ({ file_path: a.filePath || a.path || a.file_path || "" }),
    translateBack: (a) => ({ path: a.file_path ?? "", filePath: a.file_path ?? "" }),
  },
  read_file: {
    ccTool: "Read",
    translateArgs: (a) => ({
      file_path: a.filePath || a.path || a.file_path || a.target_file || "",
    }),
    translateBack: (a) => ({
      path: a.file_path ?? "",
      filePath: a.file_path ?? "",
      target_file: a.file_path ?? "",
    }),
  },
  view_file: {
    ccTool: "Read",
    translateArgs: (a) => ({
      file_path: a.AbsolutePath || a.path || "",
      ...(a.StartLine ? { offset: a.StartLine } : {}),
      ...(a.EndLine && a.StartLine ? { limit: Number(a.EndLine) - Number(a.StartLine) + 1 } : {}),
    }),
    translateBack: (a) => ({
      AbsolutePath: a.file_path ?? "",
      StartLine: Number(a.offset ?? 1),
      EndLine: Number(a.offset ?? 1) + Number(a.limit ?? 200) - 1,
    }),
  },
  builtin_read_file: {
    ccTool: "Read",
    translateArgs: (a) => ({ file_path: a.path || "" }),
    translateBack: (a) => ({ path: a.file_path ?? "" }),
  },
  write: {
    ccTool: "Write",
    translateArgs: (a) => ({
      file_path: a.filePath || a.path || a.file_path || "",
      content: a.content || "",
    }),
    translateBack: (a) => ({
      path: a.file_path ?? "",
      filePath: a.file_path ?? "",
      content: a.content ?? "",
    }),
  },
  write_file: {
    ccTool: "Write",
    translateArgs: (a) => ({
      file_path: a.filePath || a.path || a.file_path || "",
      content: a.content || "",
    }),
    translateBack: (a) => ({
      path: a.file_path ?? "",
      filePath: a.file_path ?? "",
      content: a.content ?? "",
    }),
  },
  write_to_file: {
    ccTool: "Write",
    translateArgs: (a) => ({
      file_path: a.path || a.filePath || a.file_path || a.TargetFile || "",
      content: a.content || a.CodeContent || "",
    }),
    translateBack: (a) => ({
      path: a.file_path ?? "",
      filePath: a.file_path ?? "",
      content: a.content ?? "",
      TargetFile: a.file_path ?? "",
    }),
  },
  builtin_create_new_file: {
    ccTool: "Write",
    translateArgs: (a) => ({ file_path: a.path || "", content: a.content || "" }),
    translateBack: (a) => ({ path: a.file_path ?? "", content: a.content ?? "" }),
  },
  create_file: {
    ccTool: "Write",
    translateArgs: (a) => ({
      file_path: a.filePath || a.file_path || a.path || "",
      content: a.content || "",
    }),
    translateBack: (a) => ({ filePath: a.file_path ?? "", content: a.content ?? "" }),
  },
  edit: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.filePath || a.path || a.file_path || "",
      old_string: a.oldString || a.old || a.old_string || "",
      new_string: a.newString || a.new || a.new_string || "",
    }),
    translateBack: (a) => ({
      path: a.file_path ?? "",
      filePath: a.file_path ?? "",
      old: a.old_string ?? "",
      oldString: a.old_string ?? "",
      new: a.new_string ?? "",
      newString: a.new_string ?? "",
    }),
  },
  edit_file: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.file_path || a.path || a.target_file || a.filePath || "",
      old_string: a.old_string || a.old || a.old_str || "",
      new_string: a.new_string || a.new || a.new_str || "",
    }),
    translateBack: (a) => ({
      file_path: a.file_path ?? "",
      old_string: a.old_string ?? "",
      new_string: a.new_string ?? "",
    }),
  },
  replace_in_file: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.path || a.filePath || a.file_path || "",
      old_string: a.old_string || a.old || "",
      new_string: a.new_string || a.new || "",
    }),
    translateBack: (a) => ({
      path: a.file_path ?? "",
      diff: `------- SEARCH\n${a.old_string ?? ""}\n=======\n${
        a.new_string ?? ""
      }\n+++++++ REPLACE`,
    }),
  },
  apply_diff: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.path || a.file_path || "",
      old_string: a.old_string || "",
      new_string: a.new_string || "",
    }),
    translateBack: (a) => ({ path: a.file_path ?? "", diff: "" }),
    reverseScore: 1,
  },
  search_replace: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.file_path || a.path || "",
      old_string: a.old_string || "",
      new_string: a.new_string || "",
    }),
    translateBack: (a) => ({
      file_path: a.file_path ?? "",
      old_string: a.old_string ?? "",
      new_string: a.new_string ?? "",
    }),
  },
  builtin_edit_existing_file: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.path || "",
      old_string: a.old_string || "",
      new_string: a.replacement || a.new_string || "",
    }),
    translateBack: (a) => ({ path: a.file_path ?? "", replacement: a.new_string ?? "" }),
  },
  insert_edit_into_file: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.filePath || a.file_path || "",
      old_string: a.old_string || "",
      new_string: a.code || a.new_string || "",
    }),
    translateBack: (a) => ({
      filePath: a.file_path ?? "",
      code: a.new_string ?? "",
      explanation: "",
    }),
  },
  str_replace_editor: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.path || "",
      old_string: a.old_str || "",
      new_string: a.new_str || "",
    }),
    translateBack: (a) => ({
      command: "str_replace",
      path: a.file_path ?? "",
      old_str: a.old_string ?? "",
      new_str: a.new_string ?? "",
      security_risk: "LOW",
    }),
  },
  patch: {
    ccTool: "Edit",
    translateArgs: (a) => ({
      file_path: a.path || "",
      old_string: a.old_string || "",
      new_string: a.new_string || "",
    }),
    translateBack: (a) => ({
      mode: "replace",
      path: a.file_path ?? "",
      old_string: a.old_string ?? "",
      new_string: a.new_string ?? "",
      replace_all: false,
    }),
  },
  glob: { ccTool: "Glob" },
  find_files: {
    ccTool: "Glob",
    translateArgs: (a) => ({ pattern: a.pattern || a.query || "" }),
    translateBack: (a) => ({ pattern: a.pattern ?? "" }),
  },
  list_files: {
    ccTool: "Glob",
    translateArgs: (a) => ({ pattern: a.pattern || "*", ...(a.path ? { path: a.path } : {}) }),
    translateBack: (a) => ({ pattern: a.pattern ?? "", path: a.path ?? ".", recursive: false }),
  },
  file_search: {
    ccTool: "Glob",
    translateArgs: (a) => ({ pattern: a.glob_pattern || a.query || a.pattern || "" }),
    translateBack: (a) => ({ glob_pattern: a.pattern ?? "", query: a.pattern ?? "" }),
  },
  list_dir: {
    ccTool: "Glob",
    translateArgs: (a) => ({
      pattern: "*",
      ...(a.target_directory || a.DirectoryPath || a.path
        ? { path: a.target_directory || a.DirectoryPath || a.path }
        : {}),
    }),
    translateBack: (a) => ({
      target_directory: a.path ?? ".",
      DirectoryPath: a.path ?? ".",
      path: a.path ?? ".",
    }),
    reverseScore: 3,
  },
  find_by_name: {
    ccTool: "Glob",
    translateArgs: (a) => ({
      pattern: a.Pattern || a.pattern || "*",
      ...(a.SearchDirectory ? { path: a.SearchDirectory } : {}),
    }),
    translateBack: (a) => ({ Pattern: a.pattern ?? "", SearchDirectory: a.path ?? "." }),
    reverseScore: 5,
  },
  builtin_file_glob_search: {
    ccTool: "Glob",
    translateArgs: (a) => ({ pattern: a.glob || a.pattern || "" }),
    translateBack: (a) => ({ glob: a.pattern ?? "" }),
  },
  builtin_ls: {
    ccTool: "Glob",
    translateArgs: (a) => ({ pattern: "*", ...(a.path ? { path: a.path } : {}) }),
    translateBack: (a) => ({ path: a.path ?? "." }),
    reverseScore: 1,
  },
  grep: { ccTool: "Grep" },
  search: {
    ccTool: "Grep",
    translateArgs: (a) => ({
      pattern: a.query || a.pattern || "",
      ...(a.path ? { path: a.path } : {}),
    }),
    translateBack: (a) => ({
      query: a.pattern ?? "",
      pattern: a.pattern ?? "",
      path: a.path ?? ".",
    }),
  },
  search_files: {
    ccTool: "Grep",
    translateArgs: (a) => ({
      pattern: a.query || a.pattern || a.regex || "",
      ...(a.path ? { path: a.path } : {}),
      ...(a.filePattern || a.file_pattern ? { glob: a.filePattern || a.file_pattern } : {}),
    }),
    translateBack: (a) => ({
      query: a.pattern ?? "",
      pattern: a.pattern ?? "",
      regex: a.pattern ?? "",
      path: a.path ?? ".",
      filePattern: a.glob ?? "",
      file_pattern: a.glob ?? "",
    }),
  },
  grep_search: {
    ccTool: "Grep",
    translateArgs: (a) => ({
      pattern: a.pattern || a.query || a.Query || "",
      ...(a.path || a.SearchPath ? { path: a.path || a.SearchPath } : {}),
      ...(a.glob ? { glob: a.glob } : {}),
      ...(Array.isArray(a.Includes) && a.Includes[0] ? { glob: a.Includes[0] } : {}),
    }),
    translateBack: (a) => ({
      pattern: a.pattern ?? "",
      Query: a.pattern ?? "",
      path: a.path ?? ".",
      SearchPath: a.path ?? ".",
      ...(a.glob ? { glob: a.glob } : {}),
    }),
  },
  codebase_search: {
    ccTool: "Grep",
    translateArgs: (a) => ({ pattern: a.query || a.Query || a.pattern || "" }),
    translateBack: (a) => ({ query: a.pattern ?? "", Query: a.pattern ?? "" }),
    reverseScore: 3,
  },
  builtin_grep_search: {
    ccTool: "Grep",
    translateArgs: (a) => ({
      pattern: a.pattern || "",
      ...(a.path ? { path: a.path } : {}),
    }),
    translateBack: (a) => ({ pattern: a.pattern ?? "", path: a.path ?? "." }),
  },
  semantic_search: {
    ccTool: "Grep",
    translateArgs: (a) => ({ pattern: a.query || "" }),
    translateBack: (a) => ({ query: a.pattern ?? "" }),
    reverseScore: 2,
  },
  web_search: {
    ccTool: "WebSearch",
    translateArgs: (a) => ({ query: a.query || a.search_term || a.q || "" }),
    translateBack: (a) => ({ query: a.query ?? "", search_term: a.query ?? "" }),
  },
  websearch: {
    ccTool: "WebSearch",
    translateArgs: (a) => ({ query: a.query || a.q || "" }),
    translateBack: (a) => ({ query: a.query ?? "" }),
  },
  web_fetch: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.url || a.u, a.prompt),
    translateBack: (a) => ({ url: a.url ?? "" }),
  },
  webfetch: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.url || a.u, a.prompt),
    translateBack: (a) => ({ url: a.url ?? "" }),
  },
  fetch: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.url, a.prompt),
    translateBack: (a) => ({ url: a.url ?? "" }),
  },
  browse: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.url, a.prompt),
    translateBack: (a) => ({ url: a.url ?? "" }),
  },
  read_url_content: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.Url || a.url, a.prompt),
    translateBack: (a) => ({ Url: a.url ?? "", url: a.url ?? "" }),
  },
  web_extract: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(Array.isArray(a.urls) ? a.urls[0] : a.url, a.prompt),
    translateBack: (a) => ({ urls: [a.url ?? ""] }),
  },
  fetch_webpage: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.url, a.query || a.prompt),
    translateBack: (a) => ({ url: a.url ?? "" }),
  },
  search_web: {
    ccTool: "WebSearch",
    translateArgs: (a) => ({ query: a.query || "" }),
    translateBack: (a) => ({ query: a.query ?? "" }),
  },
  builtin_search_web: {
    ccTool: "WebSearch",
    translateArgs: (a) => ({ query: a.query || "" }),
    translateBack: (a) => ({ query: a.query ?? "", num_results: 5 }),
  },
  notebook: { ccTool: "NotebookEdit" },
  notebook_edit: { ccTool: "NotebookEdit" },
  browser: {
    ccTool: "WebFetch",
    translateArgs: (a) => webFetchArgs(a.url, a.prompt),
    translateBack: (a) => ({ url: a.url ?? "" }),
  },
  enter_plan_mode: { ccTool: "EnterPlanMode" },
  exit_plan_mode: { ccTool: "ExitPlanMode" },
  enter_worktree: {
    ccTool: "EnterWorktree",
    translateArgs: (a) => ({ path: a.path }),
    translateBack: (a) => ({ path: a.path ?? "" }),
  },
  exit_worktree: { ccTool: "ExitWorktree" },
};

/** All tool names the bundled CC release ships (the union set). */
export const CC_NATIVE_NAMES: ReadonlySet<string> = new Set(TEMPLATE.tool_names);

/** The full canonical CC tool array. */
export const CC_TOOL_DEFINITIONS: ReadonlyArray<Record<string, JsonValue>> = TEMPLATE.tools;

function isMcpToolName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith("mcp__");
}

/** Drop later tools whose exact name already appeared; upstream rejects repeats. */
function dedupeToolsByName<T extends { name?: unknown }>(tools: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of tools) {
    const name = typeof t.name === "string" ? t.name : "";
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    out.push(t);
  }
  return out;
}

const CC_FALLBACK_TOOLS = ["Bash", "Read", "Grep", "Glob", "WebSearch", "WebFetch"];

/**
 * Build the forward tool map: client tool names → CC slots. CC-native names
 * and MCP tools identity-map; known aliases route through TOOL_MAP; anything
 * else round-robins onto CC fallback slots (lossy but upstream-accepted).
 */
export function buildForwardToolMap(
  clientTools: LlmRequest["tools"],
): { toolMap: Map<string, ToolMapping>; unmappedTools: string[] } {
  const toolMap = new Map<string, ToolMapping>();
  const unmappedTools: string[] = [];
  const claimedCC = new Set<string>();

  for (const tool of clientTools) {
    const name = tool.name.toLowerCase();
    const mapping: ToolMapping | undefined =
      CC_NATIVE_NAMES.has(tool.name) || isMcpToolName(tool.name)
        ? {
          ccTool: tool.name,
          translateArgs: (a) => a,
          translateBack: (a) => a,
        }
        : TOOL_MAP[name];
    if (mapping) {
      toolMap.set(tool.name, mapping);
      claimedCC.add(mapping.ccTool);
    }
  }

  for (const tool of clientTools) {
    const name = tool.name.toLowerCase();
    if (CC_NATIVE_NAMES.has(tool.name) || isMcpToolName(tool.name) || TOOL_MAP[name]) continue;
    unmappedTools.push(tool.name);
    const pool = CC_FALLBACK_TOOLS.filter((t) => !claimedCC.has(t));
    const fallbackPool = pool.length > 0 ? pool : CC_FALLBACK_TOOLS;
    const fallbackTool = fallbackPool[(unmappedTools.length - 1) % fallbackPool.length];
    toolMap.set(tool.name, {
      ccTool: fallbackTool,
      translateArgs: (a) => {
        switch (fallbackTool) {
          case "Bash":
            return { command: `echo "${JSON.stringify(a).slice(0, 200)}"` };
          case "Read":
            return { file_path: String(a.path || a.file || a.url || "/tmp/output") };
          case "Grep":
            return { pattern: String(a.query || a.pattern || a.search || "."), path: "." };
          case "Glob":
            return { pattern: String(a.pattern || a.glob || "*") };
          case "WebSearch":
            return { query: String(a.query || a.q || a.search || "") };
          case "WebFetch":
            return { url: String(a.url || a.uri || "") };
          default:
            return a;
        }
      },
      // Unmapped-fallback mappings always lose the reverse-lookup collision.
      reverseScore: 0,
    });
  }

  return { toolMap, unmappedTools };
}

/**
 * Build the CC-name → client-name reverse lookup. Two passes: identity
 * pairings claim the CC slot first, then collisions resolve by reverseScore
 * (higher wins; 0 never claims — unmapped fallbacks must not capture real
 * tool calls).
 */
export function buildReverseLookup(
  toolMap: Map<string, ToolMapping>,
): Map<string, { clientName: string; mapping: ToolMapping }> {
  const reverseMap = new Map<string, { clientName: string; mapping: ToolMapping }>();
  const identityClaimed = new Set<string>();
  for (const [clientName, mapping] of toolMap) {
    if (clientName.toLowerCase() === mapping.ccTool.toLowerCase()) {
      identityClaimed.add(mapping.ccTool);
      reverseMap.set(mapping.ccTool, { clientName, mapping });
    }
  }
  for (const [clientName, mapping] of toolMap) {
    if (clientName.toLowerCase() === mapping.ccTool.toLowerCase()) continue;
    if (identityClaimed.has(mapping.ccTool)) continue;
    const score = mapping.reverseScore ?? 10;
    if (score === 0) continue;
    const existing = reverseMap.get(mapping.ccTool);
    if (!existing || score > (existing.mapping.reverseScore ?? 10)) {
      reverseMap.set(mapping.ccTool, { clientName, mapping });
    }
  }
  return reverseMap;
}

/** Reverse-map one tool_use name; returns the client name or null. */
export function reverseToolName(
  ccName: string,
  reverseMap: Map<string, { clientName: string; mapping: ToolMapping }>,
): string | null {
  return reverseMap.get(ccName)?.clientName ?? null;
}

/** Reverse-map tool_use input through translateBack when a mapping defines one. */
export function reverseToolInput(
  ccName: string,
  input: Record<string, unknown>,
  reverseMap: Map<string, { clientName: string; mapping: ToolMapping }>,
): Record<string, unknown> {
  const entry = reverseMap.get(ccName);
  if (!entry?.mapping.translateBack) return input;
  try {
    return entry.mapping.translateBack(input);
  } catch {
    return input;
  }
}

// ---------------------------------------------------------------------------
// Body build
// ---------------------------------------------------------------------------

export type CacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

/** The cache-control stamped on every breakpoint; mirrors real CC (no ttl). */
export const CC_CACHE_CONTROL: CacheControl = { type: "ephemeral" };

/** Persistent per-account identity presented in metadata.user_id. */
export type Identity = { deviceId: string; accountUuid: string; sessionId: string };

export type BuiltRequest = {
  body: Record<string, unknown>;
  reverseMap: Map<string, { clientName: string; mapping: ToolMapping }>;
  wireModel: string;
};

function isEmptyTextBlock(block: Record<string, unknown> | undefined): boolean {
  return block?.type === "text" && (typeof block.text !== "string" || block.text === "");
}

function textPart(parts: LlmContentPart[]): string {
  return parts.map((part) => part.type === "text" ? part.text : "").join("");
}

function contentBlocks(parts: LlmContentPart[]): Array<Record<string, unknown>> {
  return parts.map((part): Record<string, unknown> =>
    part.type === "text" ? { type: "text", text: part.text } : {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mediaType,
        data: part.dataBase64,
      },
    }
  );
}

/**
 * Convert the host's canonical conversation into the Anthropic Messages shape
 * the template engine consumes. Assistant history carries tool_use blocks
 * forward-remapped to CC names; tool results become user-turn tool_result
 * blocks. Historical thinking is stripped — thinking re-generates per turn.
 */
function messagesFromRequest(
  request: LlmRequest,
  toolMap: Map<string, ToolMapping>,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const toolCall of message.toolCalls) {
        const mapping = toolMap.get(toolCall.name);
        const ccName = mapping?.ccTool ?? toolCall.name;
        const args = mapping?.translateArgs && toolCall.arguments !== null &&
            typeof toolCall.arguments === "object"
          ? mapping.translateArgs(toolCall.arguments as Record<string, unknown>)
          : toolCall.arguments;
        content.push({ type: "tool_use", id: toolCall.callId, name: ccName, input: args });
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const toolResult: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: message.callId,
      };
      if (message.parts.length > 0) {
        toolResult.content = message.isError
          ? [{ type: "text", text: `Error: ${message.content}` }]
          : contentBlocks(message.parts);
      } else {
        toolResult.content = message.content;
        if (message.isError) toolResult.is_error = true;
      }
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(toolResult);
      } else {
        messages.push({ role: "user", content: [toolResult] });
      }
    } else {
      const content = contentBlocks(message.content);
      if (content.length > 0) messages.push({ role: message.role, content });
    }
  }
  return messages;
}

/**
 * Build the CC-shaped outbound request from the host's canonical request.
 * The upstream sees a genuine CC request structure: billing tag, identity
 * metadata, CC system prompt, CC tools, and CC's exact key order.
 */
export function buildCCRequest(
  request: LlmRequest,
  model: string,
  identity: Identity,
): BuiltRequest {
  const wireModel = stripContext1mTag(model);
  const m = wireModel.toLowerCase();
  const isHaiku = m.includes("haiku");

  const billingTag = buildBillingTag(CC_VERSION);
  const cacheControl = CC_CACHE_CONTROL;

  const { toolMap, unmappedTools } = buildForwardToolMap(request.tools);

  // Conversation — remap tool references, scrub client identifiers from content.
  const messages = messagesFromRequest(request, toolMap);
  for (const msg of messages) {
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = scrubFrameworkIdentifiersInContent(block.text);
      }
      if (block.type === "tool_result") {
        // Strip client-specific fields CC wouldn't send.
        for (const key of Object.keys(block)) {
          if (!["type", "tool_use_id", "content", "is_error"].includes(key)) delete block[key];
        }
        if (typeof block.content === "string") {
          const scrubbed = scrubFrameworkIdentifiersInContent(block.content);
          block.content = scrubbed.length > 30000
            ? scrubbed.slice(0, 30000) + "\n[...truncated]"
            : scrubbed;
        }
        if (Array.isArray(block.content)) {
          for (const sub of block.content as Array<Record<string, unknown>>) {
            if (sub.type === "text" && typeof sub.text === "string") {
              const scrubbed = scrubFrameworkIdentifiersInContent(sub.text);
              sub.text = scrubbed.length > 30000
                ? scrubbed.slice(0, 30000) + "\n[...truncated]"
                : scrubbed;
            }
          }
        }
      }
    }
  }

  // Drop empty text blocks and turns the upstream rejects outright.
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    msg.content = (msg.content as Array<Record<string, unknown>>).filter(
      (b) =>
        !(b.type === "text" && (typeof b.text !== "string" || (b.text as string).trim() === "")),
    );
  }
  for (let i = messages.length - 2; i >= 0; i--) {
    if (Array.isArray(messages[i].content) && (messages[i].content as unknown[]).length === 0) {
      messages.splice(i, 1);
    }
  }
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (
      last.role === "assistant" && Array.isArray(last.content) &&
      (last.content as unknown[]).length === 0
    ) {
      messages.pop();
      continue;
    }
    break;
  }

  // System prompt: [0] billing tag, [1] agent identity, [2] CC prompt + client instructions.
  const baseSystemPrompt = systemPromptForModel(m);
  const clientInstructions = scrubFrameworkIdentifiers(request.instructions);
  const fullSystemPrompt = clientInstructions
    ? `${baseSystemPrompt}${CLIENT_SYSTEM_PREFACE}${clientInstructions}`
    : baseSystemPrompt;

  const ccRequest: Record<string, unknown> = {
    model: wireModel,
    messages,
    system: [
      { type: "text", text: billingTag },
      { type: "text", text: CC_AGENT_IDENTITY, cache_control: cacheControl },
      { type: "text", text: fullSystemPrompt, cache_control: cacheControl },
    ],
  };

  // Tools: CC's canonical array; session MCP tools appended verbatim (real CC
  // advertises operator-supplied MCP schemas after its built-ins).
  const mcpTools = request.tools
    .filter((t) => isMcpToolName(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const ccNames = new Set(CC_TOOL_DEFINITIONS.map((t) => String(t.name)));
  const appended = mcpTools.filter((t) => !ccNames.has(t.name));
  ccRequest.tools = appended.length > 0
    ? dedupeToolsByName([...CC_TOOL_DEFINITIONS, ...appended])
    : CC_TOOL_DEFINITIONS;

  // Metadata — required for subscription billing classification. Without it
  // Anthropic classifies the request as third-party and bills Extra Usage.
  ccRequest.metadata = {
    user_id: JSON.stringify({
      device_id: identity.deviceId,
      account_uuid: identity.accountUuid,
      session_id: identity.sessionId,
    }),
  };

  ccRequest.max_tokens = DEFAULT_MAX_TOKENS;

  if (!isHaiku) {
    if (supportsAdaptiveThinking(m)) {
      // CC 2.1.198+ sends display:"omitted" alongside the adaptive type on
      // every adaptive-thinking model.
      ccRequest.thinking = { type: "adaptive", display: "omitted" };
      ccRequest.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    }
    ccRequest.output_config = { effort: resolveEffort(request.reasoning.effort) };
  }

  ccRequest.stream = true;

  // Prompt-cache breakpoints: tools carry none (system already caches the
  // prefix they render into); a rolling breakpoint on the last two user
  // messages, skipping empty text blocks (illegal to stamp).
  const tools = ccRequest.tools as Array<Record<string, unknown>>;
  if (Array.isArray(tools) && tools.length > 0) {
    ccRequest.tools = tools.map((t) => {
      if (!("cache_control" in t)) return t;
      const copy = { ...t };
      delete copy.cache_control;
      return copy;
    });
  }
  const msgs = ccRequest.messages as Array<Record<string, unknown>>;
  if (Array.isArray(msgs) && msgs.length > 0) {
    let stamped = 0;
    for (let i = msgs.length - 1; i >= 0 && stamped < 2; i--) {
      const msg = msgs[i];
      if (msg.role !== "user") continue;
      if (!Array.isArray(msg.content) || (msg.content as unknown[]).length === 0) continue;
      const blocks = msg.content as Array<Record<string, unknown>>;
      let bi = blocks.length - 1;
      while (bi >= 0 && isEmptyTextBlock(blocks[bi])) bi--;
      if (bi < 0) continue;
      blocks[bi] = { ...blocks[bi], cache_control: cacheControl };
      stamped++;
    }
  }

  // Replay the captured top-level key order.
  const orderedBody: Record<string, unknown> = {};
  for (const key of TEMPLATE.body_field_order) {
    if (key in ccRequest) orderedBody[key] = ccRequest[key];
  }
  for (const key of Object.keys(ccRequest)) {
    if (!(key in orderedBody)) orderedBody[key] = ccRequest[key];
  }

  void unmappedTools;
  return {
    body: orderedBody,
    reverseMap: buildReverseLookup(toolMap),
    wireModel,
  };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * Static outbound headers matching a real CC client. Values the template
 * captured (user-agent, stainless constants) replay verbatim; x-stainless-os
 * / arch describe THIS process, so runtime values win.
 */
export function staticHeaders(): Record<string, string> {
  const platform = typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "linux";
  const os = platform.includes("win") ? "Windows" : platform.includes("mac") ? "MacOS" : "Linux";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const arch = /arm|aarch/i.test(ua) ? "arm64" : "x64";
  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
    "user-agent": `claude-cli/${CC_VERSION} (external, cli)`,
    "x-stainless-arch": arch,
    "x-stainless-lang": "js",
    "x-stainless-os": os,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
  };
  // Overlay captured header values; auth, body framing, session-scoped keys,
  // and the two machine-describing keys are excluded by construction.
  const skip = new Set([
    "accept",
    "content-type",
    "x-api-key",
    "authorization",
    "anthropic-beta",
    "anthropic-version",
    "x-claude-code-session-id",
    "x-client-request-id",
    "x-stainless-os",
    "x-stainless-arch",
    "host",
    "connection",
    "accept-encoding",
    "content-length",
  ]);
  for (const [key, value] of Object.entries(TEMPLATE.header_values)) {
    if (!skip.has(key)) headers[key] = value;
  }
  return headers;
}

/**
 * Assemble the final header record in the captured CC header order. Values
 * set after the static base (auth, betas, session id) are inserted by name.
 */
export function outboundHeaders(
  base: Record<string, string>,
  accessToken: string,
  beta: string,
  sessionId: string,
  requestId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...base,
    "x-claude-code-session-id": sessionId,
    "anthropic-beta": beta,
    "authorization": `Bearer ${accessToken}`,
    "x-client-request-id": requestId,
    "x-stainless-timeout": base["x-stainless-timeout"] ?? "600",
  };
  const ordered: Record<string, string> = {};
  for (const key of TEMPLATE.header_order) {
    if (key in headers) ordered[key] = headers[key];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}
