/**
 * Pictures from Venice's own agent, which is what the web app makes them with:
 * told to call its `generate_image` or `edit_image` server tool once with a
 * prompt, a model and an aspect ratio, it does exactly that, and the bytes
 * stream back in the same response. Undocumented upstream; see
 * opencode-venice-web's docs/PROTOCOL.md §5b for the measurements.
 */
import { randomUUID } from "node:crypto";
import { message } from "./envelope.ts";
import { freeImageModels } from "./models.ts";
import type { Agent, AgentOptions, Media } from "./venice.ts";

export interface ImageRequest {
  kind: "generation" | "edit";
  prompt: string;
  model: string;
  aspectRatio?: string;
  /** The pictures an edit works on. */
  images?: Omit<Media, "id">[];
}

export interface Picture {
  data: Buffer;
  format: string;
  /** The model Venice ran, which is not always the one it was asked for. */
  model: string;
  width: number;
  height: number;
  blurred: boolean;
  contentViolation: boolean;
}

function agentRequest(request: ImageRequest, media: Media[]) {
  const call =
    request.kind === "edit"
      ? "Call edit_image once with 1 request on the attached image(s). The request uses exactly this instruction"
      : "Call generate_image once with 1 request. The request uses exactly this prompt";
  const ratio = request.aspectRatio ? ` Aspect ratio: ${request.aspectRatio}.` : "";
  const turn = message(
    "user",
    `${call}, unchanged and not rewritten: ${JSON.stringify(request.prompt)}. Model (resource_id): ${request.model}.${ratio} Do not write anything else.`,
  );
  const attached = media.map(({ id }) => ({ type: "input_image", media_id: id, detail: "auto" }));
  return {
    input: { messages: [{ ...turn, content: [...attached, ...turn.content] }] },
    clientTools: [],
  };
}

/** The one picture of an agent response. */
async function readPicture(events: AsyncIterable<any>): Promise<Picture> {
  const chunks: Buffer[] = [];
  let model = "";
  let part: any = {};
  let reply = "";
  let completed = false;
  for await (const event of events) {
    if (event.type === "error" || event.type === "response.failed")
      throw new Error(
        event.message ?? event.response?.error?.message ?? "Venice image generation failed",
      );
    if (event.type === "response.incomplete")
      throw new Error("Venice image generation was incomplete");
    if (event.type === "response.completed") completed = true;
    if (event.item?.type === "veniceai:image_generation")
      model = event.item.requests?.[0]?.model_id ?? model;
    if (event.part?.type === "veniceai:output_image") part = { ...part, ...event.part };
    if (event.type === "veniceai:image_generation.image_chunk")
      chunks[event.chunk_index] = Buffer.from(event.image_chunk_b64, "base64");
    if (event.type === "response.output_text.delta") reply += event.delta;
  }
  if (!completed) throw new Error("the Venice stream ended before response.completed");
  // without a picture, what the agent wrote is the only explanation there is
  if (!chunks.length)
    throw new Error(`Venice made no image: ${reply.trim().slice(-300) || "empty reply"}`);
  return {
    data: Buffer.concat(chunks),
    format: part.format,
    model,
    width: part.dimensions.width,
    height: part.dimensions.height,
    blurred: part.is_blurred === true,
    contentViolation: part.is_content_violation === true,
  };
}

/** Makes one picture with a model that bills no credits. */
export async function makeImage(
  venice: { agent: Agent; agentOptions: AgentOptions },
  cookie: string,
  request: ImageRequest,
  signal?: AbortSignal,
): Promise<Picture> {
  const free = freeImageModels(await venice.agentOptions(cookie, signal), request.kind);
  if (!free.includes(request.model))
    throw new Error(
      `${request.model} is not a free Venice image ${request.kind} model; the free ones are ${free.join(", ")}`,
    );
  // Venice reads an image from the request under any id, so none is uploaded to get one
  const media = (request.images ?? []).map((image) => ({ ...image, id: randomUUID() }));
  const picture = await readPicture(
    venice.agent(cookie, agentRequest(request, media), media, signal),
  );
  // the agent swaps a model it cannot run for another one without saying so
  if (picture.model !== request.model)
    throw new Error(`Venice ran ${picture.model} instead of ${request.model}`);
  return picture;
}
