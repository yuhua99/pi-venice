import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VENICE_MODELS } from "./models.ts";
import { streamVenice } from "./stream.ts";
import { BASE_URL, chat, sessionToken } from "./venice.ts";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("venice", {
    name: "Venice",
    baseUrl: BASE_URL,
    api: "venice-web",
    models: VENICE_MODELS,
    streamSimple: (model, context, options) => streamVenice(chat, model, context, options),

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
