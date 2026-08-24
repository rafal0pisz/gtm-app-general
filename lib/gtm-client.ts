import { google, tagmanager_v2 } from "googleapis";

export function tagmanagerClient(accessToken: string): tagmanager_v2.Tagmanager {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.tagmanager({ version: "v2", auth });
}

// accountId:containerId → workspaceId. Workspaces are essentially static once
// a container is set up, so a short-lived process-wide cache avoids a list
// call on every single operation.
const WORKSPACE_CACHE_TTL_MS = 300_000;
const workspaceCache = new Map<string, { workspaceId: string; expiresAt: number }>();

export async function resolveWorkspaceId(
  tm: tagmanager_v2.Tagmanager,
  accountId: string,
  containerId: string
): Promise<string> {
  const key = `${accountId}:${containerId}`;
  const cached = workspaceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId;

  const parent = `accounts/${accountId}/containers/${containerId}`;
  const res = await tm.accounts.containers.workspaces.list({ parent });
  const workspaces = res.data.workspace ?? [];
  const chosen =
    workspaces.find((w) => w.name === "Default Workspace") ?? workspaces[0];
  if (!chosen?.workspaceId) {
    throw new Error(`No workspace found for container ${containerId}.`);
  }
  workspaceCache.set(key, {
    workspaceId: chosen.workspaceId,
    expiresAt: Date.now() + WORKSPACE_CACHE_TTL_MS,
  });
  return chosen.workspaceId;
}

export function workspacePath(accountId: string, containerId: string, workspaceId: string): string {
  return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
}
