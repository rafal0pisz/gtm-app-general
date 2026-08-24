// Per-request timeout wrapper for OAuth discovery / token-exchange / MCP HTTP calls.
// Next.js patches global fetch with caching behaviour that can stall on non-2xx
// responses. This wrapper bypasses that by:
//   1. Aborting via AbortController after timeoutMs (prevents undici's
//      30 s headersTimeout from blocking callers)
//   2. Setting cache: 'no-store' to opt out of Next.js request memoization

const DEFAULT_TIMEOUT_MS = 6_000;

export function createTimedFetch(timeoutMs = DEFAULT_TIMEOUT_MS): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = input instanceof Request ? input.url : String(input);
    const t0 = Date.now();
    console.log(`[stape/fetch] → ${url}`);
    try {
      const res = await fetch(input, {
        ...init,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cache: "no-store" as any,
        signal: controller.signal,
      });
      clearTimeout(timer);
      console.log(`[stape/fetch] ← ${res.status} [${Date.now() - t0}ms] ${url}`);
      return res;
    } catch (err) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const isTimeout = (err as Error).name === "AbortError";
      console.error(
        `[stape/fetch] ✗ ${isTimeout ? `TIMEOUT after ${timeoutMs}ms` : "ERROR"} [${ms}ms] ${url}`,
        isTimeout ? "" : err
      );
      throw err;
    }
  };
}
