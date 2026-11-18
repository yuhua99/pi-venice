/** The JSON events of an SSE byte stream; a frame's `event:` line names the type. */
export async function* sseEvents(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop()!;
    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      // comment-only frames are keepalives
      if (!data || data === "[DONE]") continue;
      const type = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const value = JSON.parse(data);
      yield { ...value, type: type || value.type };
    }
  }
}
