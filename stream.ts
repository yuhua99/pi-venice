import { randomUUID } from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { toRequest } from "./envelope.ts";
import type { Chat } from "./venice.ts";

/** The web endpoint reports no usage, so tokens are estimated from characters. */
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** The provider's `streamSimple`, over the `chat` that reaches the endpoint. */
export function streamVenice(
  chat: Chat,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  // never rejects: every failure becomes the stream's error event
  void (async () => {
    try {
      const { body, readReply } = toRequest(
        model.id,
        context.messages,
        model.reasoning ? options?.reasoning : undefined,
      );
      const request = ((await options?.onPayload?.(body, model)) ?? body) as object;

      let text = "";
      let completed = false;
      let thinking: ThinkingContent | undefined;
      const reasoningItems = new Set<number>();
      const events = chat(options?.apiKey ?? "", request, options?.signal);
      stream.push({ type: "start", partial: output });

      for await (const event of events) {
        await options?.onProviderStreamEvent?.(event, model);
        if (event.type === "error" || event.type === "response.failed")
          throw new Error(
            event.message ?? event.response?.error?.message ?? "Venice generation failed",
          );
        if (event.type === "response.incomplete")
          throw new Error("Venice generation was incomplete");
        if (event.type === "response.completed") completed = true;
        if (event.type === "response.output_item.added" && event.item?.type === "reasoning")
          reasoningItems.add(event.output_index);

        // `output_text.delta` carries reasoning too; the item it belongs to tells which
        const isText = event.type === "response.output_text.delta";
        const isReasoning = isText
          ? reasoningItems.has(event.output_index)
          : /^response\.reasoning(_summary)?_text\.delta$/.test(event.type);
        const delta: string = event.delta ?? "";
        if (isReasoning) {
          if (!thinking) {
            thinking = { type: "thinking", thinking: "" };
            output.content.push(thinking);
            stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
          }
          thinking.thinking += delta;
          stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: output });
        } else if (isText) {
          // buffered: the whole reply has to be read before it is known to be an answer or a tool call
          text += delta;
        }
      }
      if (thinking)
        stream.push({
          type: "thinking_end",
          contentIndex: 0,
          content: thinking.thinking,
          partial: output,
        });
      options?.signal?.throwIfAborted();
      if (!completed) throw new Error("the Venice stream ended before response.completed");

      const reply = readReply(text);
      if (!reply.content && !reply.calls.length) throw new Error("Venice returned an empty reply");

      if (reply.content) {
        const block: TextContent = { type: "text", text: "" };
        const contentIndex = output.content.push(block) - 1;
        stream.push({ type: "text_start", contentIndex, partial: output });
        block.text = reply.content;
        stream.push({ type: "text_delta", contentIndex, delta: reply.content, partial: output });
        stream.push({ type: "text_end", contentIndex, content: reply.content, partial: output });
      }
      for (const call of reply.calls) {
        const toolCall: ToolCall = { type: "toolCall", id: `call_${randomUUID()}`, ...call };
        const contentIndex = output.content.push(toolCall) - 1;
        const delta = JSON.stringify(call.arguments);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
      }

      output.usage.input = estimateTokens(JSON.stringify(request));
      output.usage.output = estimateTokens(text + (thinking?.thinking ?? ""));
      output.usage.totalTokens = output.usage.input + output.usage.output;
      const reason = reply.calls.length ? "toolUse" : "stop";
      output.stopReason = reason;
      stream.push({ type: "done", reason, message: output });
    } catch (error) {
      const reason = options?.signal?.aborted ? "aborted" : "error";
      output.stopReason = reason;
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason, error: output });
    }
    stream.end();
  })();

  return stream;
}
