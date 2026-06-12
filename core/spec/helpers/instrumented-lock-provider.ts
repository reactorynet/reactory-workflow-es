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
        if (this.held.has(id)) {
            this.mark(`acquire-denied:${id}`);
            return false;
        }
        this.held.add(id);
        this.mark(`acquire:${id}`);
        await this.onAcquired(id);
        return true;
    }

    public async releaseLock(id: string): Promise<void> {
        this.held.delete(id);
        this.mark(`release:${id}`);
    }

    public isHeld(id: string): boolean {
        return this.held.has(id);
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
