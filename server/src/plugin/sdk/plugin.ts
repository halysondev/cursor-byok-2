import type { ProviderSupport } from "./provider.ts";
import type { ResourceSupport } from "./resource.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Localizable text: a plain string, or a locale → text map
 * (e.g. { "en-US": "Accounts" }).
 * The host passes it through unchanged and the interface resolves it for the current
 * language; upstream-derived data such as model names stays a plain string.
 */
export type LocalizedText = string | { [locale: string]: string };

export type NetworkRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type NetworkResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** A streaming response body delivered line by line as it arrives (for SSE). */
export type NetworkEventStream = {
  status: number;
  headers: Record<string, string>;
  lines: AsyncIterable<string>;
};

/**
 * Host services received by each capability call. Network requests are limited to the
 * HTTPS hosts declared in plugin.json; when the host cancels the call it aborts via `signal`.
 */
export type PluginContext = {
  network: {
    fetch(url: string, init?: NetworkRequestInit): Promise<NetworkResponse>;
    stream(url: string, init?: NetworkRequestInit): Promise<NetworkEventStream>;
  };
  signal: AbortSignal;
};

/**
 * Provider plugin definition: a set of capability implementations. The plugin holds no
 * persistent state — resources and model catalogs are stored by the host, and everything
 * a call needs arrives through parameters.
 */
export type ProviderPluginDefinition = {
  providers: ProviderSupport[];
  resources?: ResourceSupport[];
};

let registered: ProviderPluginDefinition | undefined;

/** Registers a Provider plugin; each plugin entry may call it only once. */
export function defineProviderPlugin(definition: ProviderPluginDefinition): ProviderPluginDefinition {
  if (registered) throw new Error("defineProviderPlugin can only be called once");
  registered = definition;
  return definition;
}

export function __getRegisteredPlugin(): ProviderPluginDefinition {
  if (!registered) throw new Error("plugin entry must call defineProviderPlugin");
  return registered;
}

/** A serializable capability summary; the host collects it without invoking any capability method. */
export function __descriptor(definition: ProviderPluginDefinition) {
  return {
    providers: definition.providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description ?? null,
      providerType: provider.providerType,
      resourceType: provider.resourceType ?? null,
      hasModels: provider.models !== undefined,
    })),
    resources: (definition.resources ?? []).map((resource) => ({
      type: resource.type,
      displayName: resource.displayName,
      add: (resource.add ?? []).map((method) => ({
        type: method.type,
        id: method.id,
        displayName: method.displayName,
        description: method.description ?? null,
        callback: method.type === "oauth2.authorization-code"
          ? {
            port: method.callback?.port ?? null,
            path: method.callback?.path ?? "/oauth-callback",
          }
          : null,
      })),
      import: resource.import
        ? {
          displayName: resource.import.displayName,
          description: resource.import.description ?? null,
          accept: resource.import.accept,
          multiple: resource.import.multiple ?? false,
        }
        : null,
      actions: (resource.actions ?? []).map((action) => ({
        id: action.id,
        displayName: action.displayName,
        description: action.description ?? null,
        target: action.target ?? "resource",
        destructive: action.destructive ?? false,
      })),
      canRefresh: resource.refresh !== undefined,
      canPrepare: resource.prepare !== undefined,
      canRemove: resource.remove !== undefined,
    })),
  };
}
