import { defineProviderPlugin } from "cursor-byok:plugin";
import { claudeProvider } from "./provider.ts";
import { claudeOAuth } from "./oauth.ts";
import {
  checkSignInDrift,
  credentialImport,
  presentAccount,
  refreshAccount,
  RESOURCE_TYPE,
} from "./resources.ts";

export default defineProviderPlugin({
  providers: [claudeProvider],
  resources: [{
    type: RESOURCE_TYPE,
    displayName: "Claude accounts",
    add: [claudeOAuth],
    import: credentialImport,
    present: presentAccount,
    refresh: refreshAccount,
    actions: [checkSignInDrift],
  }],
});
