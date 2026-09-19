import { defineProviderPlugin } from "cursor-byok:plugin";
import { antigravityAuthorizationCodeOAuth } from "./oauth.ts";
import { antigravityProvider } from "./provider.ts";
import {
  credentialImport,
  prepareAccount,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProviderPlugin({
  providers: [antigravityProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: "Google accounts & API keys",
    add: [antigravityAuthorizationCodeOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
    prepare: prepareAccount,
    refreshIntervalMs: 5 * 60 * 1000,
  }],
});
