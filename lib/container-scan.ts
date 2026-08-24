// Drives the container scan from the client: feeds accounts to the server a
// chunk at a time, re-queues whatever the server ran out of time to reach,
// and retries accounts that errored before finally reporting them as failed.
//
// Kept out of the component so the queueing rules — which decide whether the
// user sees a complete list or a wall of quota errors — can be tested
// directly.

export interface ScanAccount {
  accountId: string;
  name: string;
}

export interface ScanFailure {
  accountId: string;
  name: string;
  error: string;
}

export interface ScanChunkResponse<C> {
  containers: C[];
  failedAccounts?: ScanFailure[];
  pendingAccounts?: ScanAccount[];
}

export interface ScanProgress<C> {
  containers: C[];
  done: number;
  total: number;
}

export interface ScanOptions<C> {
  accounts: ScanAccount[];
  chunkSize: number;
  maxAttempts: number;
  // When set, the scan stops as soon as every one of these has been found,
  // instead of walking every remaining account.
  targetPublicIds?: Set<string>;
  publicIdOf: (container: C) => string;
  fetchChunk: (batch: ScanAccount[]) => Promise<ScanChunkResponse<C>>;
  onProgress?: (progress: ScanProgress<C>) => void;
}

export interface ScanResult<C> {
  containers: C[];
  failedAccounts: ScanFailure[];
  // Requested public IDs that no account turned out to have.
  notFoundIds: string[];
}

export async function scanAccountsForContainers<C>(opts: ScanOptions<C>): Promise<ScanResult<C>> {
  const { accounts, chunkSize, maxAttempts, targetPublicIds, publicIdOf, fetchChunk, onProgress } = opts;

  const containers: C[] = [];
  const remaining = new Set(targetPublicIds ?? []);
  const isTargeted = remaining.size > 0;

  const queue: ScanAccount[] = [...accounts];
  const failures = new Map<string, ScanFailure>();
  // Counts every attempt ever made per account and is never cleared. Storing
  // the count on the failure entry instead would reset it each time an
  // account is re-queued, so retries could never terminate.
  const attempts = new Map<string, number>();
  let resolvedCount = 0;

  const recordFailure = (account: ScanAccount, error: string) => {
    failures.set(account.accountId, { accountId: account.accountId, name: account.name, error });
    attempts.set(account.accountId, (attempts.get(account.accountId) ?? 0) + 1);
  };

  while (queue.length > 0) {
    if (isTargeted && remaining.size === 0) break;

    const batch = queue.splice(0, chunkSize);
    let handled = batch.length;

    try {
      const data = await fetchChunk(batch);
      for (const container of data.containers) {
        const publicId = publicIdOf(container);
        if (!isTargeted || remaining.has(publicId)) {
          containers.push(container);
          remaining.delete(publicId);
        }
      }
      for (const failure of data.failedAccounts ?? []) {
        recordFailure({ accountId: failure.accountId, name: failure.name }, failure.error);
      }
      // The server hit its deadline before reaching these — not a failure,
      // just more work. Put them back at the front to keep rough ordering.
      const pending = data.pendingAccounts ?? [];
      if (pending.length > 0) {
        queue.unshift(...pending);
        handled -= pending.length;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const account of batch) recordFailure(account, message);
    }

    resolvedCount += handled;
    onProgress?.({ containers: [...containers], done: resolvedCount, total: accounts.length });

    // Once the queue drains, fold anything that failed back in for another
    // pass before giving up on it — quota errors are transient.
    if (queue.length === 0) {
      for (const failure of [...failures.values()]) {
        if ((attempts.get(failure.accountId) ?? 0) >= maxAttempts) continue;
        failures.delete(failure.accountId);
        queue.push({ accountId: failure.accountId, name: failure.name });
        resolvedCount -= 1;
      }
    }
  }

  // When every requested container was located, errors from other accounts
  // are noise — those accounts were never needed, and reporting them makes a
  // fully successful lookup look like a failure.
  const allTargetsFound = isTargeted && remaining.size === 0;

  return {
    containers,
    failedAccounts: allTargetsFound ? [] : [...failures.values()],
    notFoundIds: isTargeted ? [...remaining] : [],
  };
}
