import assert from "node:assert/strict";
import { test } from "node:test";
import { type ImageRequest, makeImage } from "../images.ts";

const options = {
  imageModelOptions: {
    generation: [
      { id: "free", usesCredits: false },
      { id: "paid", usesCredits: true },
    ],
    edit: [{ id: "free-edit", usesCredits: false }],
  },
};
const completed = { type: "response.completed" };
const picture = (model: string) => [
  {
    type: "response.output_item.added",
    item: { type: "veniceai:image_generation", requests: [{ model_id: model }] },
  },
  { type: "response.content_part.added", part: { type: "veniceai:output_image", format: "png" } },
  { type: "veniceai:image_generation.image_chunk", chunk_index: 0, image_chunk_b64: btoa("ab") },
  { type: "veniceai:image_generation.image_chunk", chunk_index: 1, image_chunk_b64: btoa("cd") },
  {
    type: "response.content_part.done",
    part: { type: "veniceai:output_image", dimensions: { width: 4, height: 2 }, is_blurred: false },
  },
  completed,
];
const venice = (events: object[]) => {
  const sent: { request: any; media: any[] }[] = [];
  return {
    sent,
    agentOptions: async () => options,
    async *agent(_cookie: string, request: object, media: any[]) {
      sent.push({ request, media });
      yield* events;
    },
  };
};
const generation: ImageRequest = { kind: "generation", prompt: 'a "red" apple', model: "free" };

test("makeImage asks the agent for the prompt, model and ratio as given and returns the picture", async () => {
  const fake = venice(picture("free"));
  const made = await makeImage(fake, "cookie", { ...generation, aspectRatio: "16:9" });
  assert.deepEqual(made, {
    data: Buffer.from("abcd"),
    format: "png",
    model: "free",
    width: 4,
    height: 2,
    blurred: false,
    contentViolation: false,
  });
  const [{ request, media }] = fake.sent;
  assert.deepEqual(media, []);
  const [{ text }] = request.input.messages[0].content;
  assert.match(text, /^Call generate_image once/);
  assert.ok(text.includes('"a \\"red\\" apple". Model (resource_id): free. Aspect ratio: 16:9.'));
});

test("makeImage sends the images of an edit with the request, each under the id the message names", async () => {
  const fake = venice(picture("free-edit"));
  const image = { mimeType: "image/png", data: new Uint8Array([1]) };
  await makeImage(fake, "cookie", {
    kind: "edit",
    prompt: "greener",
    model: "free-edit",
    images: [image, image],
  });
  const [{ request, media }] = fake.sent;
  const [first, second, instruction] = request.input.messages[0].content;
  assert.deepEqual(
    [first, second],
    media.map(({ id }) => ({ type: "input_image", media_id: id, detail: "auto" })),
  );
  assert.notEqual(media[0].id, media[1].id);
  assert.match(instruction.text, /^Call edit_image once/);
});

test("makeImage refuses a model that bills credits before asking the agent", async () => {
  const fake = venice(picture("paid"));
  await assert.rejects(
    makeImage(fake, "cookie", { ...generation, model: "paid" }),
    /paid is not a free Venice image generation model; the free ones are free$/,
  );
  assert.equal(fake.sent.length, 0);
});

test("makeImage rejects a picture from another model than the one asked for", async () => {
  await assert.rejects(
    makeImage(venice(picture("other")), "cookie", generation),
    /Venice ran other instead of free/,
  );
});

test("makeImage reports what the agent wrote when it made no picture", async () => {
  const events = [
    { type: "response.output_text.delta", delta: "That model isn't available." },
    completed,
  ];
  await assert.rejects(
    makeImage(venice(events), "cookie", generation),
    /Venice made no image: That model isn't available\./,
  );
});

test("makeImage rejects a picture whose response failed or never completed", async () => {
  const failed = [...picture("free").slice(0, -1), { type: "response.failed", message: "boom" }];
  await assert.rejects(makeImage(venice(failed), "cookie", generation), /^Error: boom$/);
  await assert.rejects(
    makeImage(venice(picture("free").slice(0, -1)), "cookie", generation),
    /ended before response\.completed/,
  );
});
