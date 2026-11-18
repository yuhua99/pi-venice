import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ImageRequest, makeImage } from "./images.ts";
import * as venice from "./venice.ts";

const GENERATION_MODEL = "z-image-turbo";
const EDIT_MODEL = "firered-image-edit";
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// some models put the @ of a file mention in front of a path argument
const absolute = (ctx: ExtensionContext, path: string) => resolve(ctx.cwd, path.replace(/^@/, ""));

const model = (fallback: string) =>
  Type.Optional(
    Type.String({
      description: `Venice model id, ${fallback} when omitted. An id that is not free is answered with the free ones.`,
    }),
  );
const output_path = Type.Optional(
  Type.String({
    description: "Where to save the PNG; a new file in the working directory when omitted",
  }),
);

async function save(
  ctx: ExtensionContext,
  request: ImageRequest,
  outputPath: string | undefined,
  signal: AbortSignal | undefined,
) {
  const cookie = await ctx.modelRegistry.getApiKeyForProvider("venice");
  if (!cookie) throw new Error("not logged in to Venice; run /login");
  const picture = await makeImage(venice, cookie, request, signal);
  const path = absolute(ctx, outputPath ?? `venice-${randomUUID().slice(0, 8)}.${picture.format}`);
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, picture.data, { signal });
  });
  const { model, width, height } = picture;
  const flags = [picture.blurred && ", blurred", picture.contentViolation && ", content violation"];
  return {
    content: [
      {
        type: "text" as const,
        text: `Saved ${path} (${model}, ${width}x${height}${flags.filter(Boolean).join("")})`,
      },
    ],
    details: { path, model, width, height },
  };
}

export function registerImageTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "venice_image_gen",
    label: "Venice Image Generation",
    description:
      "Generate an image from a text prompt with a free Venice model and save it as a PNG file. Returns the file path.",
    parameters: Type.Object({
      prompt: Type.String({ description: "What the image shows; used as written" }),
      model: model(GENERATION_MODEL),
      aspect_ratio: Type.Optional(
        Type.String({
          description:
            'W:H, such as "16:9"; the model uses the nearest ratio it supports, and its default when omitted',
        }),
      ),
      output_path,
    }),
    execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
      save(
        ctx,
        {
          kind: "generation",
          prompt: params.prompt,
          model: params.model ?? GENERATION_MODEL,
          aspectRatio: params.aspect_ratio,
        },
        params.output_path,
        signal,
      ),
  });

  pi.registerTool({
    name: "venice_image_edit",
    label: "Venice Image Edit",
    description:
      "Edit an image, or combine up to 3 images, following a text instruction with a free Venice model, and save the result as a PNG file. Returns the file path.",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "The change to make, or how to combine the images; used as written, at most 1500 characters",
      }),
      images: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 3,
        description: "Paths of the PNG, JPEG or WebP images to edit or combine",
      }),
      model: model(EDIT_MODEL),
      aspect_ratio: Type.Optional(
        Type.String({
          description:
            'W:H, such as "16:9"; the model uses the nearest ratio it supports, and the shape of the first image when omitted',
        }),
      ),
      output_path,
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const images = await Promise.all(
        params.images.map(async (path) => {
          const mimeType = MIME_TYPES[extname(path).toLowerCase()];
          if (!mimeType) throw new Error(`${path} is not a .png, .jpg, .jpeg or .webp file`);
          return { mimeType, data: await readFile(absolute(ctx, path)) };
        }),
      );
      return save(
        ctx,
        {
          kind: "edit",
          prompt: params.prompt,
          model: params.model ?? EDIT_MODEL,
          aspectRatio: params.aspect_ratio,
          images,
        },
        params.output_path,
        signal,
      );
    },
  });
}
