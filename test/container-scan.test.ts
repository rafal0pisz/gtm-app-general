import { test } from "node:test";
import assert from "node:assert/strict";
import { scanAccountsForContainers, type ScanAccount, type ScanChunkResponse } from "@/lib/container-scan";

interface Container {
  publicId: string;
  accountId: string;
}

const accounts = (n: number): ScanAccount[] =>
  Array.from({ length: n }, (_, i) => ({ accountId: String(100 + i), name: `Account ${i}` }));

const containerFor = (a: ScanAccount): Container => ({
  publicId: `GTM-${a.accountId}`,
  accountId: a.accountId,
});

const base = {
  chunkSize: 5,
  maxAttempts: 3,
  publicIdOf: (c: Container) => c.publicId,
};

test("every account is scanned and every container collected", async () => {
  const seen: string[] = [];
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(23),
    fetchChunk: async (batch) => {
      seen.push(...batch.map((a) => a.accountId));
      return { containers: batch.map(containerFor) };
    },
  });

  assert.equal(result.containers.length, 23);
  assert.equal(new Set(seen).size, 23, "each account should be requested exactly once when nothing fails");
  assert.equal(result.failedAccounts.length, 0);
});

test("accounts the server could not reach are retried, not reported as failures", async () => {
  let call = 0;
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(10),
    fetchChunk: async (batch): Promise<ScanChunkResponse<Container>> => {
      call++;
      // First call: server hits its deadline after one account.
      if (call === 1) {
        return { containers: [containerFor(batch[0])], pendingAccounts: batch.slice(1) };
      }
      return { containers: batch.map(containerFor) };
    },
  });

  assert.equal(result.containers.length, 10, "pending accounts must come back around and be scanned");
  assert.equal(result.failedAccounts.length, 0, "running out of time is not a failure");
});

test("a transient per-account failure is retried and clears itself", async () => {
  const attemptsByAccount = new Map<string, number>();
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(8),
    fetchChunk: async (batch) => {
      const containers: Container[] = [];
      const failedAccounts = [];
      for (const a of batch) {
        const n = (attemptsByAccount.get(a.accountId) ?? 0) + 1;
        attemptsByAccount.set(a.accountId, n);
        // Account 103 fails once, then succeeds — exactly like a quota hit.
        if (a.accountId === "103" && n === 1) {
          failedAccounts.push({ accountId: a.accountId, name: a.name, error: "HTTP 429: Quota exceeded" });
        } else {
          containers.push(containerFor(a));
        }
      }
      return { containers, failedAccounts };
    },
  });

  assert.equal(result.failedAccounts.length, 0, "a transient failure should not reach the user");
  assert.equal(result.containers.length, 8);
  assert.equal(attemptsByAccount.get("103"), 2, "the failing account should have been retried once");
});

test("an account that keeps failing is reported after a bounded number of attempts", async () => {
  let attempts = 0;
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(3),
    fetchChunk: async (batch) => {
      const containers: Container[] = [];
      const failedAccounts = [];
      for (const a of batch) {
        if (a.accountId === "101") {
          attempts++;
          failedAccounts.push({ accountId: a.accountId, name: a.name, error: "HTTP 403: no access" });
        } else {
          containers.push(containerFor(a));
        }
      }
      return { containers, failedAccounts };
    },
  });

  assert.equal(result.failedAccounts.length, 1);
  assert.equal(result.failedAccounts[0].accountId, "101");
  assert.equal(attempts, 3, "must stop after maxAttempts rather than retrying forever");
  assert.equal(result.containers.length, 2, "the healthy accounts are still returned");
});

test("a whole-chunk request failure is retried per account", async () => {
  let call = 0;
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(5),
    fetchChunk: async (batch) => {
      call++;
      if (call === 1) throw new Error("HTTP 504");
      return { containers: batch.map(containerFor) };
    },
  });

  assert.equal(result.containers.length, 5, "a failed chunk must not lose its accounts");
  assert.equal(result.failedAccounts.length, 0);
});

test("a targeted scan stops as soon as the requested IDs are found", async () => {
  let scanned = 0;
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(100),
    targetPublicIds: new Set(["GTM-100", "GTM-102"]),
    fetchChunk: async (batch) => {
      scanned += batch.length;
      return { containers: batch.map(containerFor) };
    },
  });

  assert.equal(result.containers.length, 2, "only the requested containers are kept");
  assert.ok(scanned < 100, `scanned ${scanned} accounts — should have stopped early once both were found`);
  assert.equal(result.notFoundIds.length, 0);
});

test("errors from unrelated accounts are not shown once every requested ID is found", async () => {
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(30),
    targetPublicIds: new Set(["GTM-100"]),
    fetchChunk: async (batch) => ({
      containers: batch.map(containerFor),
      // An account the user never asked about is unreachable.
      failedAccounts: batch
        .filter((a) => a.accountId === "101")
        .map((a) => ({ accountId: a.accountId, name: a.name, error: "HTTP 429: Quota exceeded" })),
    }),
  });

  assert.equal(result.containers.length, 1);
  assert.equal(result.notFoundIds.length, 0);
  assert.deepEqual(result.failedAccounts, [], "a fully successful lookup must not look like a failure");
});

test("requested IDs that do not exist anywhere are reported as not found", async () => {
  const result = await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(6),
    targetPublicIds: new Set(["GTM-100", "GTM-NOPE"]),
    fetchChunk: async (batch) => ({ containers: batch.map(containerFor) }),
  });

  assert.deepEqual(result.notFoundIds, ["GTM-NOPE"]);
  assert.equal(result.containers.length, 1);
});

test("progress never exceeds the total and ends complete", async () => {
  const seen: { done: number; total: number }[] = [];
  await scanAccountsForContainers<Container>({
    ...base,
    accounts: accounts(20),
    fetchChunk: async (batch) => {
      // The server only gets through part of each chunk before its deadline.
      const reached = batch.slice(0, 3);
      return { containers: reached.map(containerFor), pendingAccounts: batch.slice(3) };
    },
    onProgress: (p) => seen.push({ done: p.done, total: p.total }),
  });

  assert.ok(seen.length > 0);
  for (const p of seen) {
    assert.ok(p.done >= 0, `progress went negative: ${p.done}`);
    assert.ok(p.done <= p.total, `progress ${p.done} exceeded total ${p.total}`);
  }
  assert.equal(seen.at(-1)!.done, 20, "progress should finish at 100%");
});
