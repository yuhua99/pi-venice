import assert from "node:assert/strict";
import { test } from "node:test";
import { toRequest } from "../envelope.ts";

const tool = { name: "read", description: "Read a file", parameters: {} };
const system = (tools: object[]) => ({
  role: "system",
  content: "system",
  toolsAdded: tools,
  timestamp: 0,
});
const { readReply } = toRequest("m", [system([tool])] as any);

test("readReply reads an envelope with a tool call", () => {
  const reply = readReply(
    '{"content":"","status":"continue","tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}',
  );
  assert.deepEqual(reply, { content: "", calls: [{ name: "read", arguments: { path: "a.txt" } }] });
});

test("readReply merges several envelopes and keeps the prose around them", () => {
  const reply = readReply(
    'Let me look.\n{"content":"first","tool_calls":[{"name":"a","arguments":{}}]}\n{"content":"second","tool_calls":[{"name":"b","arguments":{"x":"}{"}}]} bye',
  );
  assert.equal(reply.content, "Let me look.\nfirst\nsecond\nbye");
  assert.deepEqual(
    reply.calls.map((call) => call.name),
    ["a", "b"],
  );
});

test("readReply leaves a reply without an envelope as content", () => {
  const text = 'The config is {"port": 3000} and {broken';
  assert.deepEqual(readReply(text), { content: text, calls: [] });
});

test("readReply ignores envelope fields of the wrong type", () => {
  assert.deepEqual(readReply('{"content":"hi","tool_calls":"none"}'), { content: "hi", calls: [] });
  assert.deepEqual(readReply('{"content":5,"tool_calls":[{"name":"a","arguments":[]}]}'), {
    content: "",
    calls: [{ name: "a", arguments: {} }],
  });
});

test("toRequest writes history as envelopes and ends with the format reminder", () => {
  const { body } = toRequest(
    "m",
    [
      system([tool]),
      { role: "user", content: "hi", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "A" }],
      },
      // a later system message does not hide that this turn follows a tool result
      { role: "system", content: "more", timestamp: 0 },
    ] as any,
    "medium",
  );
  const texts = body.messages.map((item) => [item.role, item.content[0].text]);
  assert.deepEqual(texts.slice(0, 3), [
    ["user", "hi"],
    [
      "assistant",
      '{"content":"","status":"continue","tool_calls":[{"id":"c1","name":"read","arguments":{"path":"a"}}]}',
    ],
    ["user", '{"tool_result":{"tool_call_id":"c1","content":"A"}}'],
  ]);
  assert.match(texts[3][1], /^\(format reminder\) .*next tool/);
  assert.match(body.systemPrompt.instructions, /^system\n\nmore\n\n[\s\S]*"name":"read"/);
  assert.equal(body.reasoningMode, "adaptive");
});

test("toRequest stays plain without tools, and so does the reply", () => {
  const { body, readReply } = toRequest("m", [
    system([]),
    { role: "user", content: "hi", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ] as any);
  assert.equal(body.systemPrompt.instructions, "system");
  assert.deepEqual(
    body.messages.map((item) => item.content[0].text),
    ["hi", "hello"],
  );
  assert.equal(body.reasoningMode, "disabled");
  const text = '{"content":"x","tool_calls":[]}';
  assert.deepEqual(readReply(text), { content: text, calls: [] });
});
