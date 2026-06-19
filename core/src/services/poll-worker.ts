import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, LogLevel, TYPES, QueueType, IBackgroundWorker, toError, WorkflowOptions, POLL_LEASE_KEY } from "../abstractions";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowExecutor } from "./workflow-executor";
import { drainWithTimeout } from "./drain";

@injectable()
export class PollWorker implements IBackgroundWorker {

    @inject(TYPES.IPersistenceProvider)
    private persistence: IPersistenceProvider;

    @inject(TYPES.IDistributedLockProvider)
    private lockProvider: IDistributedLockProvider;

    @inject(TYPES.IQueueProvider)
    private queueProvider: IQueueProvider;

    @inject(TYPES.ILogger)
    private logger: ILogger;

    @inject(TYPES.WorkflowOptions)
    private options: WorkflowOptions;

    // M5 §6.9: epoch-ms of the last completed poll tick, exposed for health().
    private lastPollAt: number | null = null;

    private processTimer: any;

    // H4: in-flight poll ticks (at most one at a time today). Kept as a Set so
    // the drain matches the queue workers and H1 can extend the same structure.
    private inFlight: Set<Promise<void>> = new Set();
    private shuttingDown: boolean = false;
    private drainPromise: Promise<void> | null = null;

    public start() {
        this.shuttingDown = false;
        this.drainPromise = null;
        this.processTimer = setInterval(this.tick, this.options.pollIntervalMs, this);
    }

    /**
     * H4 graceful drain: stop intake first (clear the timer, gate the tick),
     * then await any in-flight poll cycle for up to timeoutMs, then
     * force-resolve. Idempotent: repeated/concurrent calls share one drain.
     */
    public async stop(timeoutMs: number): Promise<void> {
        if (this.shuttingDown) {
            await (this.drainPromise ?? Promise.resolve());
            return;
        }
        this.shuttingDown = true;
        this.logger.log(LogLevel.Info, "Stopping poll worker...");
        if (this.processTimer) {
            clearInterval(this.processTimer);
            this.processTimer = null;
        }
        this.drainPromise = drainWithTimeout(this.inFlight, timeoutMs);
        await this.drainPromise;
    }

    /**
     * H1 (widened IBackgroundWorker): the poll worker has no bounded pool —
     * its in-flight set holds at most one lease-gated tick. Count is reported
     * from that same set; ticks have no item identity, so IDs are empty.
     */
    public getActiveCount(): number {
        return this.inFlight.size;
    }

    public getActiveIds(): string[] {
        return [];
    }

    /** M5 §6.9: epoch-ms of the last completed poll tick, or null before the first tick. */
    public getLastPollAt(): number | null {
        return this.lastPollAt;
    }

    private tick(self: PollWorker): void {
        if (self.shuttingDown)
            return;
        const p: Promise<void> = self.process(self)
            .catch((err) => {
                const error = toError(err);
                self.logger.log(LogLevel.Error, "Error running poll", { err: error });
            })
            .finally(() => {
                self.inFlight.delete(p);
            });
        self.inFlight.add(p);
    }

    private async process(self: PollWorker): Promise<void> {
        try {
            await self.processInner(self);
        }
        finally {
            // M5 §6.9: record the heartbeat at the end of every completed tick,
            // regardless of lease ownership or scan errors.
            self.lastPollAt = Date.now();
        }
    }

    private async processInner(self: PollWorker): Promise<void> {
        self.logger.log(LogLevel.Info, "pollRunnables", { now: Date.now() });

        // Elect a single active poller for this cycle via the distributed lease.
        let gotLease = false;
        try {
            gotLease = await self.lockProvider.acquireLock(POLL_LEASE_KEY);
        }
        catch (err) {
            const error = toError(err);
            self.logger.log(LogLevel.Error, "Error acquiring poll lease", { err: error });
            return; // could not determine lease ownership; skip this cycle, retry next tick
        }

        if (!gotLease) {
            self.logger.log(LogLevel.Info, "Poll lease held by another node; skipping cycle");
            return;
        }

        try {
            try {
                let runnables = await self.persistence.getRunnableInstances();
                for (let item of runnables) {
                    self.queueProvider.queueForProcessing(item, QueueType.Workflow);
                }
            }
            catch (err) {
                const error = toError(err);
                self.logger.log(LogLevel.Error, "Error polling runnable instances", { err: error });
            }

            try {
                let events = await self.persistence.getRunnableEvents();
                for (let item of events) {
                    self.queueProvider.queueForProcessing(item, QueueType.Event);
                }
            }
            catch (err) {
                const error = toError(err);
                self.logger.log(LogLevel.Error, "Error polling runnable events", { err: error });
            }
        }
        finally {
            // Always release the lease, even if a scan threw. The TTL on the lock
            // provider (C1) is the backstop if this node dies before release.
            try {
                await self.lockProvider.releaseLock(POLL_LEASE_KEY);
            }
            catch (err) {
                const error = toError(err);
                self.logger.log(LogLevel.Error, "Error releasing poll lease", { err: error });
            }
        }
    }
}