import assert from "node:assert/strict";
import { test } from "node:test";
import { streamVenice } from "../stream.ts";

const model = { id: "m", api: "venice-web", provider: "venice", reasoning: true } as any;
const tool = { name: "read", description: "Read a file", parameters: {} };
const context = (tools: object[]) =>
  ({
    messages: [
      { role: "system", content: "system", toolsAdded: tools, timestamp: 0 },
      { role: "user", content: "hi", timestamp: 0 },
    ],
  }) as any;
const chat = (events: object[]) =>
  async function* () {
    yield* events;
  };
const text = (delta: string, output_index = 0) => ({
  type: "response.output_text.delta",
  output_index,
  delta,
});
const completed = { type: "response.completed" };

test("streamVenice separates reasoning from the reply and turns an envelope into a tool call", async () => {
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
    text("hm", 0),
    text('{"content":"","status":"continue","tool_calls":[', 1),
    text('{"name":"read","arguments":{"path":"a"}}]}', 1),
    completed,
  ];
  const message = await streamVenice(chat(events), model, context([tool])).result();
  assert.equal(message.stopReason, "toolUse");
  const [thinking, call] = message.content as any[];
  assert.deepEqual(thinking, { type: "thinking", thinking: "hm" });
  assert.deepEqual([call.type, call.name, call.arguments], ["toolCall", "read", { path: "a" }]);
});

test("streamVenice keeps the reply to a request without tools as plain text", async () => {
  const reply = '{"content":"x","tool_calls":[]}';
  const message = await streamVenice(chat([text(reply), completed]), model, context([])).result();
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: reply }]);
});

test("streamVenice reports a failed generation as an error", async () => {
  const failed = { type: "response.failed", response: { error: { message: "overloaded" } } };
  const message = await streamVenice(chat([failed]), model, context([])).result();
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "overloaded");
});

test("streamVenice reports a stream cut off before completion as an error", async () => {
  const message = await streamVenice(chat([text("partial")]), model, context([])).result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /ended before response\.completed/);
});
