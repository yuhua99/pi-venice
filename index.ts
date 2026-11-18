import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { freeModels } from "./models.ts";
import { streamVenice } from "./stream.ts";
import { BASE_URL, catalogue, chat, sessionToken } from "./venice.ts";

const API = "venice-web";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("venice", {
    name: "Venice",
    baseUrl: BASE_URL,
    api: API,
    streamSimple: (model, context, options) => streamVenice(chat, model, context, options),

    // Pi asks twice: first without network access, for the list saved by the
    // last refresh (offline, `pi -p`), then with it once the account is logged in.
    async refreshModels(context) {
      const { credential, stored, allowNetwork, signal } = context;
      if (!allowNetwork || credential?.type !== "oauth")
        return [...(stored?.models ?? [])] as ProviderModelConfig[];
      const models = freeModels(await catalogue(credential.access, signal));
      const saved = models.map((model) => ({
        ...model,
        provider: "venice",
        api: API,
        baseUrl: BASE_URL,
      }));
      await context.publish({ persist: { models: saved } });
      return models;
    },

    oauth: {
      name: "Venice (web session)",

      // The credential is the browser's Clerk cookie itself: it lives for months
      // and only changes when the account signs in again, so there is nothing to refresh.
      async login(callbacks) {
        const input = await callbacks.onPrompt({
          message:
            "Paste the __client cookie of clerk.venice.ai (browser DevTools > Network > a clerk.venice.ai request > Cookie header)",
        });
        const cookie = /(?:^|;\s*)__client=([^;\s]+)/.exec(input)?.[1] ?? input.trim();
        await sessionToken(cookie, callbacks.signal);
        return { refresh: cookie, access: cookie, expires: Number.MAX_SAFE_INTEGER };
      },
      refreshToken: async (credentials) => credentials,
      getApiKey: (credentials) => credentials.access,
    },
  });
}
