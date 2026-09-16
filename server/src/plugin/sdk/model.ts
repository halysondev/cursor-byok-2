import type { JsonValue, PluginContext } from "./plugin.ts";
import type { ResourceSnapshot } from "./resource.ts";

export type ModelCapabilities = {
  images?: boolean;
};

export type ModelDefinition = {
  id: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  /** Passed back verbatim on later calls; never shown to the user. */
  privateData?: JsonValue;
};

/** A model persisted in the host catalog. */
export type ModelSnapshot = ModelDefinition;

export type ModelListInput = {
  /** The first usable resource when model discovery needs authentication, otherwise null. */
  resource: ResourceSnapshot | null;
};

export type ModelSupport = {
  /** After a successful list, the host replaces this Provider's model catalog wholesale. */
  list(input: ModelListInput, context: PluginContext): Promise<ModelDefinition[]>;
};
