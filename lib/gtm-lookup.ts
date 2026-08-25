import { tagmanagerClient, withRetry } from "@/lib/gtm-client";
import { fetchGtmAccountList, parseContainerName, type GtmContainerInfo } from "@/lib/gtm-containers";

// Finding a container by its public ID normally means walking every account
// the user can see and listing each one's containers — one call per account,
// which is what makes a full sweep slow. The API can also resolve a GTM-XXXX
// ID straight to its container, no account needed, so when the IDs are known
// up front this skips the enumeration entirely: one call per wanted
// container instead of one per account that might hold it.

export interface LookupOutcome {
  containers: GtmContainerInfo[];
  notFound: string[];
  failed: { tagId: string; error: string }[];
  // Ran out of time before these were tried — resend them, same as the scan.
  pending: string[];
}

const CONCURRENCY = 12;
const DEFAULT_DEADLINE_MS = 30_000;

function isNotFound(message: string): boolean {
  return /\b404\b|not found|notFound/i.test(message);
}

export async function lookupContainersByTagId(
  accessToken: string,
  tagIds: string[],
  deadlineMs: number = DEFAULT_DEADLINE_MS
): Promise<LookupOutcome> {
  const tm = tagmanagerClient(accessToken);
  const deadline = Date.now() + deadlineMs;

  const containers: GtmContainerInfo[] = [];
  const notFound: string[] = [];
  const failed: { tagId: string; error: string }[] = [];

  // Lookup gives an accountId but no account name, and the picker groups by
  // account — so fetch the (short, paginated) account list alongside the
  // lookups rather than before them, and fall back to the raw id if it fails.
  const accountNames = fetchGtmAccountList(accessToken)
    .then((accounts) => new Map(accounts.map((a) => [a.accountId, a.name])))
    .catch(() => new Map<string, string>());

  let next = 0;
  const takeNext = (): string | null => {
    if (next >= tagIds.length || Date.now() >= deadline) return null;
    return tagIds[next++];
  };

  const worker = async (): Promise<void> => {
    for (let tagId = takeNext(); tagId; tagId = takeNext()) {
      try {
        const res = await withRetry(
          () => tm.accounts.containers.lookup({ tagId }),
          "containers.lookup",
          { budgetMs: Math.max(0, Math.min(15_000, deadline - Date.now())) }
        );
        const c = res.data;
        if (!c?.accountId || !c.containerId) {
          notFound.push(tagId);
          continue;
        }
        containers.push({
          publicId: c.publicId ?? tagId,
          accountId: c.accountId,
          containerId: c.containerId,
          containerName: c.name ?? tagId,
          accountName: c.accountId,
          usageContext: c.usageContext ?? [],
          parsed: c.name ? parseContainerName(c.name) : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A container the user can't see, or a typo'd ID, is "not found"
        // rather than a failure worth retrying.
        if (isNotFound(message)) notFound.push(tagId);
        else failed.push({ tagId, error: message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tagIds.length) }, worker));

  const names = await accountNames;
  for (const c of containers) {
    c.accountName = names.get(c.accountId) ?? c.accountId;
  }

  return { containers, notFound, failed, pending: tagIds.slice(next) };
}
