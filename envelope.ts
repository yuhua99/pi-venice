/**
 * The Venice web request for a pi transcript and the reader of its reply
 * (pure, no I/O).
 *
 * The Venice web endpoint rejects OpenAI-style `tools` and the model ignores
 * its `clientTools`, so tools are described in the prompt and the model answers
 * with a JSON envelope:
 *
 *   {"content":"...","status":"continue","tool_calls":[{"name":"read","arguments":{}}]}
 */
import { randomUUID } from "node:crypto";
import {
  type Message,
  type ThinkingLevel,
  type ToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";

// Short and blunt on purpose: the reference measured longer, bulleted format
// instructions as advice the model then ignores.
const TOOL_PROMPT = `You are connected to an external agent that executes tools on the user's computer. These tools ARE called directly by name in \`tool_calls\`; they are NOT Venice server tools.
Return ONLY one valid JSON object, without markdown fences and without any text outside JSON, with this exact shape:
{"content":"text for the user, or an empty string","status":"continue","tool_calls":[{"name":"exact tool name","arguments":{}}]}
"status" is required and is one of:
- "continue": the request needs more work from you. tool_calls must then contain the next tool call(s).
- "done": the whole request is finished; "content" is your final answer and tool_calls is []. The final answer states the results the user asked for (numbers, names, findings, answers, what changed); "it is done" or "see the file" alone is not an answer.
- "ask": you need a decision or information that only the user can give; "content" is the question and tool_calls is [].
To request a tool, put its name and arguments in tool_calls and STOP; the agent executes it and sends a tool result in the next user message. Never invent tool results. If a task needs the filesystem, call a tool instead of guessing. Never send an empty "content" unless you are calling a tool.
"arguments" is always a JSON object: write file content into it as a properly escaped string (escape line breaks as \\n, escape quotes as \\"). Close every object: each tool call is {"name":...,"arguments":{...}}.
Do not ask the user for permission to do what they already asked for, and do not end a turn by describing what you are about to do: do it now with tool_calls and "status":"continue".`;

const REMINDER_FIRST_TURN =
  'Reply with exactly one JSON object and nothing else, with "status". If the task needs files, a command or a search, call those tools in tool_calls now with "status":"continue" - do not answer yet.';
const REMINDER_AFTER_TOOL =
  'Reply with exactly one JSON object and nothing else. If more work is needed, call the next tool now with "status":"continue". Only when the whole request is finished answer with "status":"done" and "tool_calls":[]; use "status":"ask" only for a question the user must answer.';

type Part = { type: string; text?: string };

const textOf = (content: string | Part[]): string =>
  typeof content === "string"
    ? content
    : content
        .map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image]" : ""))
        .filter(Boolean)
        .join("\n");

const message = (role: "user" | "assistant", text: string) => ({
  id: randomUUID(),
  type: "message",
  status: "completed",
  role,
  content: [{ type: "output_text", text, annotations: [] }],
});

const reasoningMode = (level?: ThinkingLevel) =>
  !level || level === "minimal"
    ? "disabled"
    : level === "low" || level === "medium"
      ? "adaptive"
      : "enabled";

export interface Reply {
  content: string;
  calls: Pick<ToolCall, "name" | "arguments">[];
}

/**
 * Builds the body of a Venice web inference request from a pi transcript, and
 * the reader of the reply to it: a request that lists tools is answered with
 * envelopes, any other with plain text.
 */
export function toRequest(modelId: string, messages: Message[], reasoning?: ThinkingLevel) {
  const tools = getCurrentTools(messages);
  const instructions = [getCurrentSystemPrompt(messages)];
  // system messages are replayed into the instructions above
  const turns = messages.filter((item) => item.role !== "system");
  const out = [];
  for (const item of turns) {
    if (item.role === "user") out.push(message("user", textOf(item.content)));
    if (item.role === "toolResult") {
      const result = { tool_call_id: item.toolCallId, content: textOf(item.content) };
      out.push(message("user", JSON.stringify({ tool_result: result })));
    }
    if (item.role === "assistant") {
      const calls = item.content.filter((part): part is ToolCall => part.type === "toolCall");
      const content = textOf(item.content);
      // an empty turn (an aborted or failed reply) would teach the model to answer with nothing
      if (!content && !calls.length) continue;
      if (!tools.length) {
        if (content) out.push(message("assistant", content));
        continue;
      }
      // History goes back in envelope form, status included: the model imitates
      // its own earlier turns, and one plain-text turn makes it drop the format.
      const envelope = {
        content,
        status: calls.length ? "continue" : "done",
        tool_calls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
      };
      out.push(message("assistant", JSON.stringify(envelope)));
    }
  }
  if (tools.length) {
    const list = tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    instructions.push(`${TOOL_PROMPT}\nAvailable tools:\n${JSON.stringify(list)}`);
    // As the last *user* message: the reference measured 4/4 tool use this way,
    // against 1/4 with the same text in the system prompt.
    const afterTool = turns.at(-1)?.role === "toolResult";
    const reminder = afterTool ? REMINDER_AFTER_TOOL : REMINDER_FIRST_TURN;
    out.push(message("user", `(format reminder) ${reminder}`));
  }
  return {
    body: {
      modelId,
      systemPrompt: { instructions: instructions.filter(Boolean).join("\n\n") },
      messages: out,
      tools: [],
      clientTools: [],
      reasoningMode: reasoningMode(reasoning),
    },
    readReply: (text: string): Reply =>
      tools.length ? parseReply(text) : { content: text, calls: [] },
  };
}

/** Index just past the balanced JSON object that starts at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function readEnvelope(json: string): Reply | null {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  // the model wrote this: a field counts only when it has the right type
  const content: unknown = value.content;
  const toolCalls: unknown = value.tool_calls;
  if (typeof content !== "string" && !Array.isArray(toolCalls)) return null;
  const calls = (Array.isArray(toolCalls) ? toolCalls : [])
    .filter((call: any) => typeof call?.name === "string")
    .map((call: any) => ({
      name: call.name,
      arguments:
        call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
          ? call.arguments
          : {},
    }));
  return { content: typeof content === "string" ? content : "", calls };
}

/**
 * Reads a reply to a request that listed tools. Models often write several
 * envelopes in one message, or prose around one, so every envelope found is
 * merged and the text outside them is kept as content. A reply without any
 * envelope is plain content.
 */
function parseReply(text: string): Reply {
  const parts: string[] = [];
  const calls: Reply["calls"] = [];
  let from = 0;
  let start = text.indexOf("{");
  while (start >= 0) {
    const end = objectEnd(text, start);
    const envelope = end > 0 ? readEnvelope(text.slice(start, end)) : null;
    if (envelope) {
      parts.push(text.slice(from, start), envelope.content);
      calls.push(...envelope.calls);
      from = end;
    }
    start = text.indexOf("{", envelope ? end : start + 1);
  }
  parts.push(text.slice(from));
  const content = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return { content, calls };
}
