import { defineProviderPlugin } from "cursor-byok:plugin";
import { opencodexProvider } from "./provider.ts";
import { formAdd, presentEndpoint, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [opencodexProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: "OpenCodex endpoints",
    add: [formAdd],
    present: presentEndpoint,
  }],
});
