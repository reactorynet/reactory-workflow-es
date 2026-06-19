import { injectable } from "inversify";
import { IDistributedLockProvider } from "@reactorynet/workflow-es";
import { Redis } from "ioredis";
import Redlock, { Lock } from "redlock";

/**
 * Distributed lock provider backed by Redlock (redlock v5) over ioredis v5.
 *
 * acquireLock returns true when the lock is obtained and false when it is already
 * held elsewhere (never throws on contention). Acquired leases are auto-renewed on a
 * timer via Lock.extend so a long-running step does not lose its lock mid-execution.
 */
@injectable()
export class RedisLockManager implements IDistributedLockProvider {

    private leaseDurationMs: number = 60000;
    private renewIntervalMs: number = 45000;
    private leases: Map<string, Lock> = new Map<string, Lock>();
    private renewTimer: any;
    private redlock: Redlock;

    constructor(connection: Redis) {
        // retryCount 0: a single attempt — contention should surface as false, not a retry storm.
        this.redlock = new Redlock([connection as any], { retryCount: 0 });
        // Redlock emits 'error' on background renewal/quorum failures; swallow to avoid
        // crashing the host process (the CAS token is the durable safety net).
        this.redlock.on("error", () => { /* tolerated */ });
        this.renewTimer = setInterval(() => this.renewLeases(), this.renewIntervalMs);
        if (this.renewTimer.unref)
            this.renewTimer.unref();
    }

    public async acquireLock(id: string): Promise<boolean> {
        try {
            const lock = await this.redlock.acquire([this.resourceKey(id)], this.leaseDurationMs);
            this.leases.set(id, lock);
            return true;
        }
        catch {
            return false;
        }
    }

    public async releaseLock(id: string): Promise<void> {
        const lock = this.leases.get(id);
        if (!lock)
            return;
        this.leases.delete(id);
        try {
            await lock.release();
        }
        catch {
            // Tolerate an already-expired/lost lock.
        }
    }

    /** Stop the renew timer and release any held leases. */
    public async dispose(): Promise<void> {
        if (this.renewTimer)
            clearInterval(this.renewTimer);
        const ids = Array.from(this.leases.keys());
        for (const id of ids)
            await this.releaseLock(id);
    }

    private renewLeases(): void {
        this.leases.forEach(async (lock, id) => {
            try {
                const extended = await lock.extend(this.leaseDurationMs);
                this.leases.set(id, extended);
            }
            catch {
                // Lost the lease; drop it so a future acquireLock can re-take it.
                this.leases.delete(id);
            }
        });
    }

    private resourceKey(id: string): string {
        // M6: `id` arrives already tenant-namespaced (`tenant:resourceId`) from the
        // core workers; it is opaque here and used verbatim as the Redlock resource
        // name. ':' is a legal Redis key character, so no sanitisation is needed.
        return `wes:lock:${id}`;
    }
}
