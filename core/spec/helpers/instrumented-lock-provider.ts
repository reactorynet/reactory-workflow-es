import { IDistributedLockProvider } from "../../src";

/**
 * Test-only IDistributedLockProvider (H2 spec §4 / §8).
 *
 * - Honours real mutual exclusion: a second acquireLock for a held id returns
 *   false, matching SingleNodeLockProvider semantics.
 * - Records the call order of acquire/release per id (plus any extra markers a
 *   test pushes via mark(), e.g. "subscribe:<id>" / "requeue:<id>") into a
 *   shared `order` log, so tests can assert post-processing happened BEFORE
 *   the lock was released.
 * - `recording` gates the log so a test can scope assertions to the window it
 *   controls (e.g. excluding the initial startWorkflow enqueue, which is
 *   legitimately outside any lock, and the 10s poll-worker tick).
 * - `onAcquired` lets a test deterministically interleave two acquisitions:
 *   delay the first holder so a concurrent duplicate attempt is provably
 *   denied while the lock is held.
 */
export class InstrumentedLockProvider implements IDistributedLockProvider {
    public order: string[] = [];
    public recording: boolean = true;
    public onAcquired: (id: string) => Promise<void> = async () => { };
    private held: Set<string> = new Set<string>();

    public async acquireLock(id: string): Promise<boolean> {
        // M6: lock keys are tenant-namespaced (`tenant:resourceId`). Markers are
        // keyed by the bare RESOURCE id so they correlate with custom markers
        // (requeue:<id> / subscribe:<workflowId>) that use the bare id, and with
        // onAcquired's resource-id comparison. Mutual exclusion still uses the
        // full namespaced key (`held` set), so two tenants on the same resource
        // do not collide.
        const resourceId = this.resourceId(id);
        if (this.held.has(id)) {
            this.mark(`acquire-denied:${resourceId}`);
            return false;
        }
        this.held.add(id);
        this.mark(`acquire:${resourceId}`);
        await this.onAcquired(resourceId);
        return true;
    }

    public async releaseLock(id: string): Promise<void> {
        this.held.delete(id);
        this.mark(`release:${this.resourceId(id)}`);
    }

    public isHeld(id: string): boolean {
        return this.held.has(id);
    }

    /** Strip a leading `tenant:` namespace from a lock key, leaving the bare id. */
    private resourceId(id: string): string {
        const idx = id.indexOf(":");
        return idx === -1 ? id : id.slice(idx + 1);
    }

    /** Push a marker into the shared order log (no-op when not recording). */
    public mark(marker: string): void {
        if (this.recording)
            this.order.push(marker);
    }

    /** All recorded markers for one id (acquire/release/denied/custom). */
    public forId(id: string): string[] {
        return this.order.filter(x => x.endsWith(":" + id));
    }

    /**
     * Markers (entries `<prefix>:<id>` for the given prefixes) that were
     * recorded while the lock for `id` was NOT held — i.e. ordering-contract
     * violations. Walks the whole log to track held state, but only reports
     * offenders at index >= fromIndex. Empty result = every marker occurred
     * between an acquire:<id> and its release:<id>.
     */
    public offendingMarkers(id: string, markerPrefixes: string[], fromIndex: number = 0): string[] {
        let held = false;
        const offenders: string[] = [];
        this.order.forEach((entry, idx) => {
            if (entry === `acquire:${id}`) {
                held = true;
                return;
            }
            if (entry === `release:${id}`) {
                held = false;
                return;
            }
            for (const prefix of markerPrefixes) {
                if (entry === `${prefix}:${id}` && !held && idx >= fromIndex)
                    offenders.push(`${idx}:${entry}`);
            }
        });
        return offenders;
    }
}
