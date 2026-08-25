import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage stand-in — the module only needs get/set/remove, and
// this also lets a test simulate storage being unavailable or full.
class MemoryStorage {
  private map = new Map<string, string>();
  throwOnWrite = false;
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnWrite) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  get size(): number {
    return this.map.size;
  }
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

const { loadCachedScan, saveCachedScan, clearCachedScan, describeCacheAge } = await import(
  "@/lib/container-cache"
);

type Container = Parameters<typeof saveCachedScan>[1][number];

const container = (publicId: string): Container => ({
  accountId: "1",
  accountName: "Account",
  containerId: publicId,
  containerName: `${publicId} name`,
  publicId,
  usageContext: ["web"],
  parsed: null,
});

test("a saved scan comes back for the same account", () => {
  saveCachedScan("user@example.com", [container("GTM-AAA"), container("GTM-BBB")], 250);
  const loaded = loadCachedScan("user@example.com");
  assert.ok(loaded);
  assert.equal(loaded.containers.length, 2);
  assert.equal(loaded.pacingMs, 250);
  assert.ok(loaded.savedAt > 0);
});

test("caches are scoped per account so a different login sees nothing", () => {
  saveCachedScan("a@example.com", [container("GTM-AAA")]);
  assert.equal(loadCachedScan("b@example.com"), null, "another account must not see this list");
  assert.ok(loadCachedScan("a@example.com"));
});

test("clearing removes the saved list", () => {
  saveCachedScan("clear@example.com", [container("GTM-AAA")]);
  clearCachedScan("clear@example.com");
  assert.equal(loadCachedScan("clear@example.com"), null);
});

test("an empty list is never cached — it would hide the real one behind nothing", () => {
  saveCachedScan("empty@example.com", []);
  assert.equal(loadCachedScan("empty@example.com"), null);
});

test("corrupt stored data is treated as no cache rather than throwing", () => {
  storage.setItem("gtm-container-cache:v1:broken@example.com", "{not json");
  assert.equal(loadCachedScan("broken@example.com"), null);
});

test("storage being full does not break the scan", () => {
  storage.throwOnWrite = true;
  try {
    assert.doesNotThrow(() => saveCachedScan("full@example.com", [container("GTM-AAA")]));
  } finally {
    storage.throwOnWrite = false;
  }
});

test("cache age reads naturally", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  assert.equal(describeCacheAge(now - 10_000, now), "just now");
  assert.equal(describeCacheAge(now - 5 * 60_000, now), "5 min ago");
  assert.equal(describeCacheAge(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(describeCacheAge(now - 2 * 86_400_000, now), "2 d ago");
});
