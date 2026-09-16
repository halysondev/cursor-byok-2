import { defineProviderPlugin } from "cursor-byok:plugin";
import { antigravityAuthorizationCodeOAuth } from "./oauth.ts";
import { antigravityProvider } from "./provider.ts";
import { credentialImport, presentAccount, refreshAccount, RESOURCE_TYPE } from "./resources.ts";

export default defineProviderPlugin({
  providers: [antigravityProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: "Google accounts & API keys",
    add: [antigravityAuthorizationCodeOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
  }],
});
