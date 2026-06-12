import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, TYPES, QueueType, IBackgroundWorker, toError, WorkflowOptions, POLL_LEASE_KEY } from "../abstractions";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowExecutor } from "./workflow-executor";

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

    private processTimer: any;

    public start() {
        this.processTimer = setInterval(this.process, this.options.pollIntervalMs, this);
    }

    public stop() {
        this.logger.log("Stopping poll worker...");
        if (this.processTimer)
            clearInterval(this.processTimer);
    }

    private async process(self: PollWorker): Promise<void> {
        self.logger.info("pollRunnables " + " - now = " + Date.now());

        // Elect a single active poller for this cycle via the distributed lease.
        let gotLease = false;
        try {
            gotLease = await self.lockProvider.acquireLock(POLL_LEASE_KEY);
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error acquiring poll lease: " + error.message);
            return; // could not determine lease ownership; skip this cycle, retry next tick
        }

        if (!gotLease) {
            self.logger.log("Poll lease held by another node; skipping cycle");
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
                self.logger.error("Error running poll: " + error.message);
            }

            try {
                let events = await self.persistence.getRunnableEvents();
                for (let item of events) {
                    self.queueProvider.queueForProcessing(item, QueueType.Event);
                }
            }
            catch (err) {
                const error = toError(err);
                self.logger.error("Error running poll: " + error.message);
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
                self.logger.error("Error releasing poll lease: " + error.message);
            }
        }
    }
}