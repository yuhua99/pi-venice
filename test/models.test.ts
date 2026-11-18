import assert from "node:assert/strict";
import { test } from "node:test";
import { freeImageModels, freeModels } from "../models.ts";

const entry = (id: string, fields: object = {}) => ({
  id,
  friendly_name: "Qwen",
  maxContextLength: 1000,
  maxResponseTokens: 100,
  usesCredits: false,
  ...fields,
});

test("freeModels keeps the text models that use no credits", () => {
  const catalogue = {
    text: {
      models: [
        entry("free"),
        entry("paid", { usesCredits: true }),
        entry("unknown", { usesCredits: undefined }),
      ],
    },
    image: { models: [entry("picture")] },
  };
  assert.deepEqual(freeModels(catalogue), [
    {
      id: "free",
      name: "Qwen",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    },
  ]);
});

test("freeModels marks reasoning models and tells a TEE variant from its twin by name", () => {
  const models = freeModels({
    text: {
      models: [
        entry("plain", { supportsReasoning: true }),
        entry("e2ee-plain", { capabilities: { e2ee: true } }),
      ],
    },
  });
  assert.deepEqual(
    models.map((model: any) => [model.name, model.reasoning]),
    [
      ["Qwen", true],
      ["Qwen TEE", false],
    ],
  );
});

test("freeModels rejects a response that is not the catalogue", () => {
  assert.throws(() => freeModels({ error: "unauthorized" }), /lists no text models/);
});

test("freeModels rejects the catalogue when a free model has no token limits", () => {
  const models = [entry("fine"), entry("broken", { maxResponseTokens: undefined })];
  assert.throws(() => freeModels({ text: { models } }), /no token limits for broken/);
  const paid = entry("paid", { usesCredits: true, maxContextLength: "many" });
  assert.equal(freeModels({ text: { models: [paid, entry("fine")] } }).length, 1);
});

test("freeImageModels keeps the agent's image models of one kind that use no credits", () => {
  const options = {
    imageModelOptions: {
      generation: [
        { id: "free", usesCredits: false },
        { id: "paid", usesCredits: true },
        { id: "unknown" },
      ],
      edit: [{ id: "free-edit", usesCredits: false }],
    },
  };
  assert.deepEqual(freeImageModels(options, "generation"), ["free"]);
  assert.deepEqual(freeImageModels(options, "edit"), ["free-edit"]);
  assert.throws(() => freeImageModels({}, "edit"), /lists no image edit models/);
});
