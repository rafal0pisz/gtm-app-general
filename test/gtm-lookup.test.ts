import { test } from "node:test";
import assert from "node:assert/strict";
// The bundled copy under googleapis-common is the one the client actually
// resolves — see gtm-workspaces.test.ts.
import { Gaxios } from "googleapis-common/node_modules/gaxios/build/cjs/src/index.js";
import { lookupContainersByTagId } from "@/lib/gtm-lookup";

type GaxiosRequest = (this: Gaxios, opts?: Record<string, unknown>) => Promise<unknown>;

interface StubOptions {
  // tagId -> container payload, or "404" / "500" to fail it
  respond: (tagId: string) => { status?: number; body: unknown };
  latencyMs?: number;
  accountsFail?: boolean;
}

function stub(opts: StubOptions) {
  const proto = Gaxios.prototype as unknown as { request: GaxiosRequest };
  const originalRequest = proto.request;
  const originalFetch = globalThis.fetch;
  let lookupCalls = 0;

  const fetchImplementation = (async (input: unknown) => {
    const url = new URL(String(input));
    const tagId = url.searchParams.get("tagId") ?? "";
    lookupCalls++;
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const { status = 200, body } = opts.respond(tagId);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  proto.request = function patched(o = {}) {
    return originalRequest.call(this, { ...o, fetchImplementation });
  };

  // fetchGtmAccountList uses plain fetch, not the googleapis client.
  globalThis.fetch = (async () => {
    if (opts.accountsFail) return new Response("nope", { status: 500 });
    return new Response(
      JSON.stringify({ account: [{ accountId: "77", name: "Aurilo GA4" }] }),
      { status: 200 }
    );
  }) as typeof fetch;

  return {
    get lookupCalls() {
      return lookupCalls;
    },
    restore: () => {
      proto.request = originalRequest;
      globalThis.fetch = originalFetch;
    },
  };
}

const container = (tagId: string) => ({
  accountId: "77",
  containerId: `c-${tagId}`,
  publicId: tagId,
  name: "example.com - PL",
  usageContext: ["web"],
});

test("IDs are resolved straight to containers, one call each, with no account scanning", async () => {
  const s = stub({ respond: (tagId) => ({ body: container(tagId) }) });
  try {
    const out = await lookupContainersByTagId("token", ["GTM-AAA", "GTM-BBB", "GTM-CCC"]);
    assert.equal(out.containers.length, 3);
    assert.equal(out.notFound.length, 0);
    assert.equal(out.failed.length, 0);
    assert.equal(s.lookupCalls, 3, "exactly one lookup per requested ID — no per-account listing");
    assert.equal(out.containers[0].accountName, "Aurilo GA4", "account name is filled in for the picker");
    assert.deepEqual(out.containers[0].parsed, { domain: "example.com", countryCode: "PL" });
  } finally {
    s.restore();
  }
});

test("an unknown or inaccessible ID is reported as not found, not as an error", async () => {
  const s = stub({
    respond: (tagId) =>
      tagId === "GTM-GHOST"
        ? { status: 404, body: { error: { code: 404, message: "Not found" } } }
        : { body: container(tagId) },
  });
  try {
    const out = await lookupContainersByTagId("token", ["GTM-AAA", "GTM-GHOST"]);
    assert.equal(out.containers.length, 1);
    assert.deepEqual(out.notFound, ["GTM-GHOST"]);
    assert.equal(out.failed.length, 0, "a missing container is not a failure to retry");
  } finally {
    s.restore();
  }
});

test("a real error is kept separate from not-found so it can be retried", async () => {
  const s = stub({
    respond: (tagId) =>
      tagId === "GTM-BOOM"
        ? { status: 500, body: { error: { code: 500, message: "Backend error" } } }
        : { body: container(tagId) },
  });
  try {
    const out = await lookupContainersByTagId("token", ["GTM-AAA", "GTM-BOOM"]);
    assert.equal(out.containers.length, 1);
    assert.equal(out.notFound.length, 0);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].tagId, "GTM-BOOM");
  } finally {
    s.restore();
  }
});

test("IDs not reached before the deadline come back as pending, not lost", async () => {
  const s = stub({ respond: (tagId) => ({ body: container(tagId) }), latencyMs: 60 });
  try {
    const ids = Array.from({ length: 200 }, (_, i) => `GTM-${i}`);
    const out = await lookupContainersByTagId("token", ids, 300);
    assert.ok(out.pending.length > 0, "the deadline must hand back what it did not reach");
    const accounted = out.containers.length + out.notFound.length + out.failed.length + out.pending.length;
    assert.equal(accounted, ids.length, "every requested ID must be accounted for exactly once");
  } finally {
    s.restore();
  }
});

test("containers still resolve when the account-name lookup fails", async () => {
  const s = stub({ respond: (tagId) => ({ body: container(tagId) }), accountsFail: true });
  try {
    const out = await lookupContainersByTagId("token", ["GTM-AAA"]);
    assert.equal(out.containers.length, 1);
    assert.equal(out.containers[0].accountName, "77", "falls back to the account id rather than failing");
  } finally {
    s.restore();
  }
});
