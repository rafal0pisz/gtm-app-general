import { randomUUID } from "crypto";

interface OAuthStateEntry {
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __oauthStateMap: Map<string, OAuthStateEntry> | undefined;
}

function getMap(): Map<string, OAuthStateEntry> {
  if (!global.__oauthStateMap) {
    global.__oauthStateMap = new Map();
  }
  return global.__oauthStateMap;
}

const TTL_MS = 10 * 60 * 1000;

export function createOAuthState(): string {
  const state = randomUUID();
  getMap().set(state, { expiresAt: Date.now() + TTL_MS });
  return state;
}

export function consumeOAuthState(state: string): boolean {
  const map = getMap();
  const entry = map.get(state);
  if (!entry) return false;
  map.delete(state);
  if (Date.now() > entry.expiresAt) return false;
  return true;
}
