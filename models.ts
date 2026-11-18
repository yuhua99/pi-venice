import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * The chat models that the venice.ai web catalogue (`GET /api/app/models`)
 * flags `usesCredits: false`: unlimited in the web chat on a paid plan, and
 * not billed to the API balance.
 */
export function freeModels(catalogue: any): ProviderModelConfig[] {
  const models: unknown = catalogue?.text?.models;
  if (!Array.isArray(models)) throw new Error("the Venice model catalogue lists no text models");
  return models
    .filter((model) => model.usesCredits === false)
    .map((model) => {
      // pi takes these as they are, and a model without them would be saved and never compacted
      const limits = [model.maxContextLength, model.maxResponseTokens];
      if (!limits.every((limit) => Number.isFinite(limit) && limit > 0))
        throw new Error(`the Venice model catalogue gives no token limits for ${model.id}`);
      return model;
    })
    .map((model) => ({
      id: model.id,
      // the catalogue gives a model and its TEE variant the same name
      name: model.capabilities?.e2ee ? `${model.friendly_name} TEE` : model.friendly_name,
      reasoning: model.supportsReasoning === true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.maxContextLength,
      maxTokens: model.maxResponseTokens,
    }));
}
