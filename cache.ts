type Timed = { value: string; expires: number };

/** `promise`, or a rejection with the abort reason as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Per-key cache of a short-lived credential: concurrent callers share one
 * mint, and an expired or failed one is minted again.
 */
export function cached(mint: (key: string, signal?: AbortSignal) => Promise<Timed>) {
  const entries = new Map<string, Promise<Timed>>();
  return async function get(key: string, signal?: AbortSignal): Promise<string> {
    const pending = entries.get(key);
    // a mint in flight follows its own caller's signal, so this caller stops waiting on its own
    const hit =
      pending &&
      (await unlessAborted(
        pending.catch(() => undefined),
        signal,
      ));
    if (hit && hit.expires > Date.now()) return hit.value;
    // another caller started a mint while this one waited: share it
    if (entries.get(key) !== pending) return get(key, signal);
    const minted = mint(key, signal);
    entries.set(key, minted);
    return (await minted).value;
  };
}
