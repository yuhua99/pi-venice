import assert from "node:assert/strict";
import { test } from "node:test";
import { sseEvents } from "../sse.ts";

test("sseEvents reads frames split across chunks and skips keepalives", async () => {
  const encoder = new TextEncoder();
  const wire =
    'event: response.output_text.delta\ndata: {"delta":"hé"}\n\n: keepalive\n\ndata: {"type":"response.completed"}\r\n\r\ndata: [DONE]\n\n';
  const bytes = encoder.encode(wire);
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7);
  }
  const events = [];
  for await (const event of sseEvents(chunks())) events.push(event);
  assert.deepEqual(events, [
    { type: "response.output_text.delta", delta: "hé" },
    { type: "response.completed" },
  ]);
});
