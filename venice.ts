/**
 * venice.ai web client: the browser's long-lived Clerk `__client` cookie is
 * exchanged for a ~60 s session JWT, which authorises the web app's own
 * inference endpoint. Undocumented upstream; see opencode-venice-web's
 * docs/PROTOCOL.md for the measurements behind the choices below.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cached } from "./cache.ts";
import { sseEvents } from "./sse.ts";

const CLERK = "https://clerk.venice.ai";
export const BASE_URL = "https://outerface.venice.ai";
// Pinned to what the venice.ai web client sends. A sudden run of HTTP 400s
// usually means Venice shipped a new client and these moved.
const CLERK_VERSION = "?__clerk_api_version=2026-05-12&_clerk_js_version=6.39.0";
const MIDDLEFACE_VERSION = "0.1.1128";
// Cloudflare challenges anything that does not look like a browser.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const browserHeaders = (cookie: string) => ({
  origin: "https://venice.ai",
  referer: "https://venice.ai/",
  cookie: `__client=${cookie}`,
});

async function clerk(
  cookie: string,
  path: string,
  init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
): Promise<any> {
  const response = await fetch(`${CLERK}${path}${CLERK_VERSION}`, {
    ...init,
    headers: { "user-agent": USER_AGENT, ...browserHeaders(cookie), ...init?.headers },
  });
  if (!response.ok)
    throw new Error(
      `Clerk rejected the Venice session (HTTP ${response.status}); run /login again`,
    );
  return response.json();
}

/** Session JWT for a `__client` cookie, cached until shortly before it expires. */
export const sessionToken = cached(async (cookie, signal) => {
  const client = await clerk(cookie, "/v1/client", { signal });
  const sessions: any[] = client.response?.sessions ?? client.client?.sessions ?? [];
  const session = sessions.find((item) => item.status === "active");
  if (!session)
    throw new Error(
      "no active Venice session for this cookie; sign in on venice.ai and run /login again",
    );
  const { jwt } = await clerk(cookie, `/v1/client/sessions/${session.id}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "organization_id=&tab_state=focused&force_origin=true",
    signal,
  });
  if (typeof jwt !== "string") throw new Error("Clerk returned no session token; run /login again");
  const { exp } = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  return { value: jwt, expires: exp * 1000 - 15_000 };
});

let tlsArgs: string[] | undefined;

/**
 * Cloudflare rejects the ClientHello of an OpenSSL-backed curl on this host
 * unless it offers TLS 1.3 only. Other builds pass as they are, and macOS curl
 * does not have the flag.
 */
function curlTlsArgs(): string[] {
  tlsArgs ??= / OpenSSL\/\d/.test(
    execFileSync("curl", ["--version"], { encoding: "utf8" }).split("\n")[0],
  )
    ? ["--tlsv1.3"]
    : [];
  return tlsArgs;
}

/**
 * Requests `path` on the Venice API host and yields the response body: a POST
 * of `body`, or a GET without one.
 *
 * Through the system curl, because Cloudflare blocks Node's own HTTP client on
 * this host whatever the headers. It only lets curl through over HTTP/1.1, with
 * the user agent passed by `-A` (header order matters) and without
 * `accept: text/event-stream`. Headers go through a private file so the bearer
 * token never shows up in the process list.
 */
async function* curl(
  cookie: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  const tls = curlTlsArgs();
  const dir = mkdtempSync(join(tmpdir(), "pi-venice-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const headerFile = join(dir, "headers");
    // the empty Expect stops curl from sending `Expect: 100-continue` for large bodies
    const lines = Object.entries({ ...browserHeaders(cookie), ...headers, expect: "" });
    writeFileSync(headerFile, lines.map(([key, value]) => `${key}: ${value}\n`).join(""), {
      mode: 0o600,
    });
    child = spawn(
      "curl",
      // --fail-with-body: an HTTP error becomes exit code 22 with the body still on stdout
      [
        "-sS",
        "--http1.1",
        "--no-buffer",
        "--proto",
        "=https",
        "--fail-with-body",
        ...tls,
        "-A",
        USER_AGENT,
        "-H",
        `@${headerFile}`,
        ...(body === undefined ? [] : ["--data-binary", "@-"]),
        BASE_URL + path,
      ],
      { signal },
    );
    const closed = new Promise<number | null | Error>((resolve) =>
      child!.once("error", resolve).once("close", resolve),
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {}); // curl may exit before it has read the whole body
    child.stdin.end(body);

    let head = "";
    for await (const chunk of child.stdout) {
      if (head.length < 300) head += chunk;
      yield chunk;
    }
    const result = await closed;
    if (result instanceof Error) throw result;
    if (result !== 0)
      throw new Error(
        `Venice request failed: ${stderr.trim()} ${head.slice(0, 300).replace(/\s+/g, " ")}`,
      );
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const apiHeaders = async (cookie: string, signal?: AbortSignal) => ({
  authorization: `Bearer ${await sessionToken(cookie, signal)}`,
  "content-type": "application/json",
  "x-venice-middleface-version": MIDDLEFACE_VERSION,
  "x-venice-request-timestamp-ms": String(Date.now()),
});

async function json(body: AsyncIterable<Buffer>): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** The inference route wants a client attestation token next to the session JWT. */
const attestation = cached(async (cookie, signal) => {
  const headers = await apiHeaders(cookie, signal);
  const body = JSON.stringify({ env: {} });
  const mint = curl(cookie, "/api/app/user/client_attestation/mint", headers, body, signal);
  const { token } = await json(mint);
  return { value: token, expires: Date.now() + 5 * 60_000 };
});

/** The web app's model catalogue, as served: every model of every kind, free or not. */
export async function catalogue(cookie: string, signal?: AbortSignal): Promise<unknown> {
  const headers = await apiHeaders(cookie, signal);
  return json(curl(cookie, "/api/app/models", headers, undefined, signal));
}

/** Runs one request on the web inference endpoint and yields its parsed SSE events. */
export async function* chat(
  cookie: string,
  request: object,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  const headers = {
    ...(await apiHeaders(cookie, signal)),
    "x-venice-client-attestation": await attestation(cookie, signal),
  };
  // Venice answers "String must not contain null bytes" (HTTP 400) once a NUL
  // reaches the request, and tool output of a binary file puts one there.
  const body = JSON.stringify(request, (_key, value) =>
    typeof value === "string" ? value.replaceAll("\0", "") : value,
  );
  yield* sseEvents(curl(cookie, "/api/inference/chat/agents/ad-hoc", headers, body, signal));
}

export type Chat = typeof chat;
