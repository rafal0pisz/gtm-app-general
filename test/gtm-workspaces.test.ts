import { test } from "node:test";
import assert from "node:assert/strict";
// Deliberately the copy nested under googleapis-common, not the top-level
// one: googleapis resolves its own bundled gaxios, so patching the
// top-level package leaves the real client untouched and the test quietly
// talks to Google instead of the stub.
import { Gaxios } from "googleapis-common/node_modules/gaxios/build/cjs/src/index.js";
import { bulkCreateVersionsFromWorkspaces, bulkListWorkspaces } from "@/lib/gtm-bulk-ops";

// Requests go through a private Gaxios instance, so neither globalThis.fetch
// nor gaxios's shared defaults can intercept them. Gaxios does read a
// per-request `fetchImplementation` though, so injecting one there routes
// every call to the stub while leaving the rest of the real code path
// intact.
interface Route {
  match: RegExp;
  respond: (url: URL, init: RequestInit) => { status?: number; body: unknown };
}

type GaxiosRequest = (this: Gaxios, opts?: Record<string, unknown>) => Promise<unknown>;

function stubApi(routes: Route[]) {
  const proto = Gaxios.prototype as unknown as { request: GaxiosRequest };
  const originalRequest = proto.request;
  const calls: string[] = [];

  const fetchImplementation = (async (input: unknown, init: RequestInit = {}) => {
    const raw =
      typeof input === "string" || input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push(key);

    for (const route of routes) {
      if (route.match.test(key)) {
        const { status = 200, body } = route.respond(url, init);
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: { message: `unrouted: ${key}` } }), { status: 500 });
  }) as typeof fetch;

  proto.request = function patched(opts = {}) {
    return originalRequest.call(this, { ...opts, fetchImplementation });
  };

  return {
    calls,
    restore: () => {
      proto.request = originalRequest;
    },
  };
}

const target = (containerId: string) => ({
  accountId: "100",
  containerId,
  containerName: `Container ${containerId}`,
});

test("workspaces are listed per container, including non-default ones", async () => {
  const stub = stubApi([
    {
      match: /GET .*\/workspaces$/,
      respond: (url) => {
        const containerId = /containers\/(\w+)/.exec(url.pathname)![1];
        return {
          body: {
            workspace: [
              { workspaceId: "1", name: "Default Workspace", containerId },
              { workspaceId: "7", name: "Marketing draft", description: "Q3 tags", containerId },
            ],
          },
        };
      },
    },
  ]);

  try {
    const results = await bulkListWorkspaces("token", [target("aaa"), target("bbb")]);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.error, undefined);
      assert.deepEqual(
        r.workspaces.map((w) => w.name),
        ["Default Workspace", "Marketing draft"],
        "every workspace must be offered, not just the default one"
      );
      assert.equal(r.workspaces[1].description, "Q3 tags");
    }
  } finally {
    stub.restore();
  }
});

test("a container whose workspaces cannot be read is reported without sinking the others", async () => {
  const stub = stubApi([
    {
      match: /GET .*\/workspaces$/,
      respond: (url) => {
        if (url.pathname.includes("/containers/bad/")) {
          return { status: 403, body: { error: { code: 403, message: "no access" } } };
        }
        return { body: { workspace: [{ workspaceId: "1", name: "Default Workspace" }] } };
      },
    },
  ]);

  try {
    const results = await bulkListWorkspaces("token", [target("good"), target("bad")]);
    const good = results.find((r) => r.containerId === "good")!;
    const bad = results.find((r) => r.containerId === "bad")!;
    assert.equal(good.workspaces.length, 1);
    assert.ok(bad.error, "the failing container must carry an error");
    assert.equal(bad.workspaces.length, 0);
  } finally {
    stub.restore();
  }
});

test("a version is created from the chosen workspace, not always the default one", async () => {
  const versionedPaths: string[] = [];
  const stub = stubApi([
    {
      match: /POST .*:create_version$/,
      respond: (url) => {
        versionedPaths.push(url.pathname);
        return { body: { containerVersion: { containerVersionId: "42", name: "Release" } } };
      },
    },
  ]);

  try {
    const results = await bulkCreateVersionsFromWorkspaces(
      "token",
      [{ ...target("aaa"), workspaceId: "7" }],
      "Release",
      "notes"
    );
    assert.equal(results[0].status, "ok");
    assert.equal(results[0].versionId, "42");
    assert.ok(
      versionedPaths[0].includes("/workspaces/7"),
      `versioned ${versionedPaths[0]} — must use the workspace the user picked`
    );
  } finally {
    stub.restore();
  }
});

test("a workspace with nothing to publish is an error, not a silent success", async () => {
  const stub = stubApi([
    // GTM answers 200 with no containerVersion when there is nothing new.
    { match: /POST .*:create_version$/, respond: () => ({ body: {} }) },
  ]);

  try {
    const results = await bulkCreateVersionsFromWorkspaces(
      "token",
      [{ ...target("aaa"), workspaceId: "1" }],
      "Release",
      undefined
    );
    assert.equal(results[0].status, "error");
    assert.equal(results[0].versionId, undefined);
    assert.match(results[0].error!, /no changes/i);
  } finally {
    stub.restore();
  }
});

test("a container that fails to compile is reported instead of publishing nothing", async () => {
  const stub = stubApi([
    {
      match: /POST .*:create_version$/,
      respond: () => ({
        body: { compilerError: true, containerVersion: { containerVersionId: "9" } },
      }),
    },
  ]);

  try {
    const results = await bulkCreateVersionsFromWorkspaces(
      "token",
      [{ ...target("aaa"), workspaceId: "1" }],
      "Release",
      undefined
    );
    assert.equal(results[0].status, "error");
    assert.match(results[0].error!, /compile/i);
  } finally {
    stub.restore();
  }
});

test("one container failing to version does not stop the rest", async () => {
  const stub = stubApi([
    {
      match: /POST .*:create_version$/,
      respond: (url) => {
        if (url.pathname.includes("/containers/bad/")) {
          return { status: 400, body: { error: { code: 400, message: "workspace is out of sync" } } };
        }
        return { body: { containerVersion: { containerVersionId: "5", name: "Release" } } };
      },
    },
  ]);

  try {
    const results = await bulkCreateVersionsFromWorkspaces(
      "token",
      [
        { ...target("good"), workspaceId: "1" },
        { ...target("bad"), workspaceId: "1" },
      ],
      "Release",
      undefined
    );
    assert.equal(results.find((r) => r.containerId === "good")!.status, "ok");
    assert.equal(results.find((r) => r.containerId === "bad")!.status, "error");
  } finally {
    stub.restore();
  }
});
