/**
 * Models the venice.ai web catalogue flags `usesCredits: false`: unlimited in
 * the web chat on a paid plan, and not billed to the API balance.
 */
const model = (
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  reasoning: boolean,
) => ({
  id,
  name,
  reasoning,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens,
});

export const VENICE_MODELS = [
  model("deepseek-v4-1-flash-free", "DeepSeek V4.1 Flash Uncensored", 524_288, 32_768, true),
  model("qwen-3-8-27b", "Qwen 3.8 27B", 262_144, 65_536, true),
  model("qwen3-6-27b", "Qwen 3.6 27B", 256_000, 65_536, true),
  model("qwen3-5-35b-a3b", "Qwen 3.5 35B A3B", 256_000, 16_384, true),
  model("zai-org-glm-5.2", "GLM 5.2", 1_000_000, 131_072, true),
  model("zai-org-glm-4.6", "GLM 4.6", 198_000, 16_384, false),
  model("venice-uncensored-1-2", "Venice Uncensored 1.2", 128_000, 8_192, false),
  model("google-gemma-4-31b-it", "Gemma 4 31B Instruct", 256_000, 8_192, true),
  model("google-gemma-4-26b-a4b-it", "Gemma 4 26B A4B Instruct", 256_000, 8_192, true),
  model("gemma4-uncensored", "Gemma 4 Uncensored", 256_000, 8_192, false),
  model("aion-labs-aion-3-0", "Aion 3.0", 128_000, 32_768, true),
  model("aion-labs-aion-3-0-mini", "Aion 3.0 Mini", 128_000, 32_768, true),
  model("deepseek-ai-DeepSeek-V3.2", "DeepSeek V3.2", 160_000, 32_768, true),
  model("e2ee-qwen3-8-27b", "Qwen 3.8 27B TEE", 262_144, 8_192, true),
  model("e2ee-gpt-oss-120b-p", "GPT OSS 120B TEE", 128_000, 32_768, true),
  model("e2ee-qwen3-6-35b-a3b", "Qwen 3.6 35B A3B FP8 TEE", 32_000, 4_096, true),
  model(
    "e2ee-gemma-4-26b-a4b-uncensored-p",
    "Gemma 4 26B A4B Uncensored TEE",
    64_000,
    4_096,
    false,
  ),
  model("e2ee-qwen-2-5-7b-p", "Qwen 2.5 7B TEE", 32_000, 4_096, false),
  model("e2ee-qwen3-vl-30b-a3b-p", "Qwen3 VL 30B A3B TEE", 128_000, 4_096, false),
];
