import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event, WorkflowExecutorResult } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, TYPES, QueueType, IBackgroundWorker, toError, WorkflowConcurrencyError, WorkflowOptions, IMetrics, METRIC_NAMES, ATTR } from "../abstractions";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowExecutor } from "./workflow-executor";
import { drainWithTimeout } from "./drain";
import { DataCodecRunner } from "./data-codec-runner";

@injectable()
export class WorkflowQueueWorker implements IBackgroundWorker {

    @inject(TYPES.IWorkflowExecutor) 
    private  executor: IWorkflowExecutor;

    @inject(TYPES.IPersistenceProvider)
    private persistence: IPersistenceProvider;

    @inject(TYPES.IDistributedLockProvider)
    private lockProvider: IDistributedLockProvider;

    @inject(TYPES.IQueueProvider)
    private queueProvider:  IQueueProvider;

    @inject(TYPES.ILogger)
    private logger: ILogger;

    @inject(TYPES.WorkflowOptions)
    private options: WorkflowOptions;

    @inject(TYPES.IMetrics)
    private metrics: IMetrics;

    // H6 — central at-rest codec boundary.
    @inject(DataCodecRunner)
    private codecRunner: DataCodecRunner;

    private processTimer: any;

    // H4 + H1: the single in-flight tracking structure. Keys are the tracked
    // processWorkflow promises H4's stop() drains (each self-removes in its
    // .finally); values are the workflow IDs H1 exposes via getActiveIds().
    // inFlight.size is the sole source of truth for the concurrency cap.
    private inFlight: Map<Promise<void>, string> = new Map();
    private shuttingDown: boolean = false;
    private started: boolean = false;
    private drainPromise: Promise<void> | null = null;

    public start() {
        // H1 (rule §6.6): idempotent — never arm a second timer chain.
        if (this.started)
            return;
        this.started = true;
        this.shuttingDown = false;
        this.drainPromise = null;
        this.scheduleNext();
    }

    /**
     * H4 graceful drain: stop intake first (clear the timer, gate the dequeue
     * loop), then await all in-flight executions for up to timeoutMs, then
     * force-resolve. Idempotent: repeated/concurrent calls share one drain.
     */
    public async stop(timeoutMs: number): Promise<void> {
        if (this.shuttingDown) {
            await (this.drainPromise ?? Promise.resolve());
            return;
        }
        this.shuttingDown = true;
        this.started = false;
        this.logger.log("Stopping workflow queue worker...");
        if (this.processTimer) {
            clearTimeout(this.processTimer);
            this.processTimer = null;
        }
        this.drainPromise = drainWithTimeout(this.inFlight.keys(), timeoutMs);
        await this.drainPromise;
    }

    /** H1 (rule §6.5): live in-flight count, backed by the H4 drain set. */
    public getActiveCount(): number {
        return this.inFlight.size;
    }

    /** H1 (rule §6.5): snapshot copy of the workflow IDs currently in flight. */
    public getActiveIds(): string[] {
        return Array.from(this.inFlight.values());
    }

    /** H1 (rule §6.3): exactly one self-rescheduling setTimeout — no stacking interval timer. */
    private scheduleNext() {
        if (this.shuttingDown)
            return;
        this.processTimer = setTimeout(() => { this.processQueue(this); }, this.options.workflowQueueIntervalMs);
    }

    private async processQueue(self: WorkflowQueueWorker): Promise<void> {
        // M5 §6.7/§6.8: record the active-workflows gauge (from H1's getActiveCount —
        // no new counter) and the workflow queue-depth gauge (if the provider implements
        // the optional getQueueLength probe) once per cycle. Telemetry never breaks the loop.
        await self.recordGauges(self);
        try {
            // H1 backpressure (rules §6.1/§6.2): dequeue-and-start only while a
            // slot is free; at capacity, leave pending items on the queue for the
            // next cycle. The slot is reserved synchronously (inFlight.set) before
            // the next dequeue await so the cap can never be overshot.
            while (!self.shuttingDown && self.inFlight.size < self.options.maxConcurrentWorkflows) {
                const workflowId = await self.queueProvider.dequeueForProcessing(QueueType.Workflow);
                if (!workflowId)
                    break;
                self.logger.log("Dequeued workflow " + workflowId + " for processing");
                const id = workflowId;
                const p: Promise<void> = self.processWorkflow(self, id)
                    .catch((err) => {
                        self.logger.error("Error processing workflow", id, err);
                    })
                    .finally(() => {
                        self.inFlight.delete(p);
                    });
                self.inFlight.set(p, id);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing workflow queue: " + error.message);
        }
        finally {
            // H1 (rules §6.3/§6.8): re-arm after the dequeue-and-dispatch phase
            // (not after in-flight work settles); the worker self-heals after errors.
            self.scheduleNext();
        }
    }

    private async recordGauges(self: WorkflowQueueWorker): Promise<void> {
        try {
            self.metrics.recordGauge(METRIC_NAMES.WORKFLOW_ACTIVE, self.getActiveCount());
            const qp: any = self.queueProvider;
            if (typeof qp.getQueueLength === "function") {
                const depth = await qp.getQueueLength(QueueType.Workflow);
                self.metrics.recordGauge(METRIC_NAMES.QUEUE_DEPTH, depth, { [ATTR.QUEUE]: "workflow" });
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error recording workflow queue gauges (ignored): " + error.message);
        }
    }

    private async processWorkflow(self: WorkflowQueueWorker, workflowId: string): Promise<void> {
        try {
            const gotLock = await self.lockProvider.acquireLock(workflowId);
            if (gotLock) {
                // H2 (spec §6.1/.2): everything state-derived — load, execute, persist,
                // subscription creation, event seeding, and the re-queue decision —
                // happens INSIDE the lock; releaseLock is the sole finally and the
                // last action on every acquired path.
                try {
                    let instance: WorkflowInstance = await self.persistence.getWorkflowInstance(workflowId);
                    if (!instance)
                        throw new Error(`Workflow ${workflowId} not found`);

                    // H6: decode the opaque payload after read, before the executor sees it.
                    await self.codecRunner.decodeInstance(instance);

                    if (instance.status == WorkflowStatus.Runnable) {
                        let complete = false;
                        let result: WorkflowExecutorResult;
                        try {
                            result = await self.executor.execute(instance);
                            complete = true;
                        }
                        finally {
                            try {
                                // H6: encode immediately before persist, then restore plaintext
                                // on the in-memory instance (post-processing below reads it, and
                                // MemoryPersistenceProvider would otherwise hand back ciphertext).
                                await self.codecRunner.encodeInstance(instance);
                                await self.persistence.persistWorkflow(instance);
                                await self.codecRunner.decodeInstance(instance);
                            }
                            catch (persistErr) {
                                if (persistErr instanceof WorkflowConcurrencyError) {
                                    // Another node persisted this instance first. Discard our
                                    // in-memory state, skip post-processing, and re-queue —
                                    // still inside the lock — for a fresh load-execute-persist
                                    // cycle (specs C1 §6.7, H2 §6.2).
                                    complete = false;
                                    self.logger.info("Concurrency conflict persisting workflow %s; re-queueing", workflowId);
                                    await self.queueProvider.queueForProcessing(workflowId, QueueType.Workflow);
                                }
                                else {
                                    throw persistErr;
                                }
                            }
                        }

                        if (complete) {
                            //TODO: cleanup
                            for (let sub of result.subscriptions) {
                                await self.subscribeEvent(self, sub);
                            }

                            if ((instance.status == WorkflowStatus.Runnable) && (instance.nextExecution !== null)) {
                                if (instance.nextExecution < Date.now()) {
                                    await self.queueProvider.queueForProcessing(workflowId, QueueType.Workflow);
                                }
                            }
                        }
                    }
                }
                finally {
                    await self.lockProvider.releaseLock(workflowId);
                }
            }
            else {
                self.logger.log("Workflow locked: " + workflowId);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.error("Error processing workflow: " + error.message);
        }
    }

    private async subscribeEvent(self: WorkflowQueueWorker, subscription: EventSubscription) {
        //TODO: move to own class

        // H2 (spec §6.5): at-most-once per (workflowId, eventName, eventKey,
        // subscribeAsOf). If the subscription already exists, the event-seeding
        // below already ran when it was first created — skip both.
        const existing = await self.persistence.getSubscriptions(subscription.eventName, subscription.eventKey, subscription.subscribeAsOf);
        if (existing.some(s => s.workflowId === subscription.workflowId))
            return;

        await self.persistence.createEventSubscription(subscription);
        let events = await self.persistence.getEvents(subscription.eventName, subscription.eventKey, subscription.subscribeAsOf);
        for (let evt of events) {
            await self.persistence.markEventUnprocessed(evt);
            await self.queueProvider.queueForProcessing(evt, QueueType.Event);
        }
    }
}