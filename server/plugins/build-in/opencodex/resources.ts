import type { JsonValue } from "cursor-byok:plugin";
import type {
  FormAddMethod,
  ResourceDraft,
  ResourceSnapshot,
  ResourceView,
} from "cursor-byok:resource";
import { fetchModels } from "./models.ts";

export const RESOURCE_TYPE = "opencodex-endpoint";

/** Shape of a single opencodex-endpoint resource's privateData. */
export type EndpointData = {
  baseUrl: string;
  apiKey: string;
  displayName: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Normalizes a user-entered base URL to `https://host/<path>`, defaulting the path to /v1. */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Base URL must start with https://");
  }
  if (url.protocol !== "https:" || !url.host) {
    throw new Error("Base URL must start with https://");
  }
  const path = url.pathname.replace(/\/+$/, "") || "/v1";
  return `https://${url.host}${path}`;
}

export function endpointData(resource: ResourceSnapshot): EndpointData {
  const data = object(resource.privateData);
  const baseUrl = text(data?.baseUrl);
  const apiKey = text(data?.apiKey);
  if (!baseUrl || !apiKey) {
    throw new Error("OpenCodex endpoint resource is missing its base URL or API key");
  }
  return {
    baseUrl,
    apiKey,
    displayName: text(data?.displayName) ?? new URL(baseUrl).host,
  };
}

export function presentEndpoint(resource: ResourceSnapshot): ResourceView {
  const data = endpointData(resource);
  return { displayName: data.displayName, description: data.baseUrl };
}

export const formAdd: FormAddMethod = {
  type: "form",
  id: "endpoint",
  displayName: "Connect an OpenCodex endpoint",
  description: "Enter the proxy base URL and API key; models are discovered automatically.",
  fields: [
    {
      id: "base-url",
      label: "Base URL",
      placeholder: "https://your-proxy.example.com/v1",
      required: true,
    },
    { id: "api-key", label: "API key", secret: true, required: true },
    { id: "name", label: "Display name", placeholder: "Optional", required: false },
  ],
  submit: async (values, context): Promise<ResourceDraft[]> => {
    const baseUrl = normalizeBaseUrl(values["base-url"] ?? "");
    const apiKey = (values["api-key"] ?? "").trim();
    if (!apiKey) throw new Error("API key is required");
    await fetchModels(baseUrl, apiKey, context);
    const name = (values["name"] ?? "").trim();
    const data: EndpointData = {
      baseUrl,
      apiKey,
      displayName: name || new URL(baseUrl).host,
    };
    return [{ key: baseUrl, privateData: data as unknown as JsonValue }];
  },
};
