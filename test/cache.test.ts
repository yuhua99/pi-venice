import assert from "node:assert/strict";
import { test } from "node:test";
import { cached } from "../cache.ts";

const later = () => Date.now() + 60_000;

test("cached shares one mint between concurrent callers and keeps it per key", async () => {
  let mints = 0;
  const get = cached(async () => ({ value: String(++mints), expires: later() }));
  assert.deepEqual(await Promise.all([get("a"), get("a")]), ["1", "1"]);
  assert.equal(await get("a"), "1");
  assert.equal(await get("b"), "2");
});

test("cached mints again after a failure or an expiry", async () => {
  let mints = 0;
  const get = cached(async () => {
    if (++mints === 1) throw new Error("down");
    return { value: String(mints), expires: mints === 2 ? 0 : later() };
  });
  await assert.rejects(get("a"), /down/);
  assert.equal(await get("a"), "2");
  assert.equal(await get("a"), "3");
  assert.equal(await get("a"), "3");
});

test("cached lets a caller stop waiting for a mint another caller started", async () => {
  const get = cached(() => new Promise(() => {}));
  void get("a");
  const controller = new AbortController();
  const waiting = get("a", controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
