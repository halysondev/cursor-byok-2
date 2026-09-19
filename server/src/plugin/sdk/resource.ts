import type { JsonValue, LocalizedText, PluginContext } from "./plugin.ts";

/**
 * A resource is a plugin-defined private record (usually an upstream account) consumed by Providers.
 * The host persists, lists, and selects the resource for each call; the plugin only creates,
 * projects, and interprets resources.
 */
export type ResourceState =
  | { status: "ready" }
  | { status: "cooling"; retryAtMs?: number; message?: string }
  | { status: "invalid"; message?: string };

/** A new resource produced by an add flow or an import. */
export type ResourceDraft = {
  /** Deduplication key: the host upserts on (resource type, key). */
  key: string;
  /** Credentials and plugin-private fields; never shown to the user. */
  privateData: JsonValue;
  /** Defaults to ready. */
  state?: ResourceState;
};

/** A resource persisted by the host. */
export type ResourceSnapshot = {
  /** Host-assigned identifier, distinct from the plugin's deduplication key. */
  id: string;
  type: string;
  key: string;
  privateData: JsonValue;
  state: ResourceState;
};

/** A partial update the host applies atomically to a single resource. */
export type ResourcePatch = {
  privateData?: JsonValue;
  state?: ResourceState;
};

export type ResourceMetric = {
  id: string;
  label: LocalizedText;
  unit: "percent" | "count";
  /** A percent metric expresses the remaining share, 0..100. */
  value: number;
  resetAtMs?: number;
};

export type ResourceActionTarget = "resource" | "card";

export type ResourceAction = {
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  target?: ResourceActionTarget;
  destructive?: boolean;
  run(
    resource: ResourceSnapshot,
    input: JsonValue,
    context: PluginContext,
  ): Promise<ResourceActionResult>;
};

export type ResourceActionField = {
  id: string;
  label: LocalizedText;
  value: string;
};

/** A generic detail card returned by a resource action; must not contain credentials. */
export type ResourceActionCard = {
  id: string;
  title: LocalizedText;
  status?: LocalizedText;
  grantedAtMs?: number;
  expiresAtMs?: number;
  fields?: ResourceActionField[];
};

export type ResourceActionResult = {
  title: LocalizedText;
  description?: LocalizedText;
  cards?: ResourceActionCard[];
  /** Consuming actions may use it to update the resource state saved by the host. */
  patch?: ResourcePatch;
};

/** The user-visible projection of a single resource; must not leak credentials. displayName is data (e.g. an email), kept as a plain string. */
export type ResourceView = {
  displayName: string;
  description?: LocalizedText;
  metrics?: ResourceMetric[];
};

/**
 * OAuth 2.0 device-code add flow. The host renders the UI, drives the polling loop
 * (interval, slow-down backoff, timeout), and holds `session` in memory for the life of
 * the flow; the plugin only implements two HTTP state transitions.
 */
export type OAuth2AddMethod = {
  type: "oauth2.0";
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  begin(context: PluginContext): Promise<OAuth2Begin>;
  poll(session: JsonValue, context: PluginContext): Promise<OAuth2Poll>;
};

export type OAuth2Begin = {
  /** Opaque flow state (e.g. a device code); never persisted. */
  session: JsonValue;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresAtMs: number;
  pollIntervalMs: number;
};

export type OAuth2Poll =
  | { status: "pending"; session?: JsonValue }
  | { status: "slow-down"; session?: JsonValue }
  | { status: "completed"; resources: ResourceDraft[] }
  | { status: "denied"; message?: string }
  | { status: "failed"; message: string };

/** OAuth 2.0 authorization-code flow where Core hosts the browser callback, state, and PKCE. */
export type OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code";
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  /** Set only when the upstream OAuth client requires a fixed loopback address. */
  callback?: { port?: number; path?: string };
  begin(
    input: {
      redirectUri: string;
      state: string;
      codeChallenge: string;
    },
    context: PluginContext,
  ): Promise<OAuth2AuthorizationCodeBegin>;
  complete(
    session: JsonValue,
    input: {
      code: string;
      redirectUri: string;
      codeVerifier: string;
    },
    context: PluginContext,
  ): Promise<ResourceDraft[]>;
};

export type OAuth2AuthorizationCodeBegin = {
  session: JsonValue;
  authorizationUrl: string;
  expiresAtMs: number;
  pollIntervalMs?: number;
};

export type ResourceAddMethod = OAuth2AddMethod | OAuth2AuthorizationCodeAddMethod;

export type ResourceImportFile = {
  name: string;
  /** Raw file contents; parsing and validation are the plugin's job. */
  content: string;
};

export type ResourceImportSupport = {
  displayName: LocalizedText;
  description?: LocalizedText;
  /** Extensions accepted by the host file picker, e.g. [".json"]. */
  accept: string[];
  multiple?: boolean;
  parse(files: ResourceImportFile[], context: PluginContext): Promise<ResourceImportResult>;
};

export type ResourceImportResult = {
  resources: ResourceDraft[];
  /** Per-file problems worth surfacing without failing the whole import. */
  warnings?: string[];
};

export type ResourceSupport = {
  type: string;
  displayName: LocalizedText;
  add?: ResourceAddMethod[];
  import?: ResourceImportSupport;
  present(resource: ResourceSnapshot): ResourceView;
  actions?: ResourceAction[];
  /** Runs before use. The host serializes this per account and persists its patch before proceeding.
   * rejectedResource is the snapshot rejected with HTTP 401, or null for a normal expiry check.
   */
  prepare?(
    resource: ResourceSnapshot,
    rejectedResource: ResourceSnapshot | null,
    context: PluginContext,
  ): Promise<ResourcePatch | null>;
  /** Re-reads upstream state (quota, credential validity) when the user triggers it. */
  refresh?(resource: ResourceSnapshot, context: PluginContext): Promise<ResourcePatch>;
  /** Optional background refresh interval; without it the host never auto-refreshes. */
  refreshIntervalMs?: number;
  /** Optional upstream revocation; the host deletes the local record afterwards. */
  remove?(resource: ResourceSnapshot, context: PluginContext): Promise<void>;
};
