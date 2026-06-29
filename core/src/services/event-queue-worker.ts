import { inject, injectable } from "inversify";
import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription, Event } from "../models";
import { WorkflowBase, IPersistenceProvider, IWorkflowHost, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger, LogLevel, TYPES, QueueType, IBackgroundWorker, toError, WorkflowOptions, IMetrics, METRIC_NAMES, ATTR, DEFAULT_TENANT, tenantLockKey } from "../abstractions";
import { WorkflowRegistry } from "./workflow-registry";
import { WorkflowExecutor } from "./workflow-executor";
import { drainWithTimeout } from "./drain";
import { DataCodecRunner } from "./data-codec-runner";

@injectable()
export class EventQueueWorker implements IBackgroundWorker {

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
    // processEvent promises H4's stop() drains (each self-removes in its
    // .finally); values are the event IDs H1 exposes via getActiveIds().
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
        this.logger.log(LogLevel.Info, "Stopping event queue worker...");
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

    /** H1 (rule §6.5): snapshot copy of the event IDs currently in flight. */
    public getActiveIds(): string[] {
        return Array.from(this.inFlight.values());
    }

    /** H1 (rule §6.3): exactly one self-rescheduling setTimeout — no stacking interval timer. */
    private scheduleNext() {
        if (this.shuttingDown)
            return;
        this.processTimer = setTimeout(() => { this.processQueue(this); }, this.options.eventQueueIntervalMs);
    }

    private async processQueue(self: EventQueueWorker): Promise<void> {
        // M5 §6.8: record the event queue-depth gauge once per cycle if the provider
        // implements the optional getQueueLength probe. Telemetry never breaks the loop.
        await self.recordQueueDepth(self);
        try {
            // H1 backpressure (rules §6.1/§6.2): dequeue-and-start only while a
            // slot is free; at capacity, leave pending items on the queue for the
            // next cycle. The slot is reserved synchronously (inFlight.set) before
            // the next dequeue await so the cap can never be overshot.
            while (!self.shuttingDown && self.inFlight.size < self.options.maxConcurrentEvents) {
                const eventId = await self.queueProvider.dequeueForProcessing(QueueType.Event);
                if (!eventId)
                    break;
                self.logger.log(LogLevel.Info, "Dequeued event for processing", { eventId });
                const id = eventId;
                const p: Promise<void> = self.processEvent(self, id)
                    .catch((err) => {
                        self.logger.log(LogLevel.Error, "Error processing event", { eventId: id, err: toError(err) });
                    })
                    .finally(() => {
                        self.inFlight.delete(p);
                    });
                self.inFlight.set(p, id);
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.log(LogLevel.Error, "Error processing event queue", { err: error });
        }
        finally {
            // H1 (rules §6.3/§6.8): re-arm after the dequeue-and-dispatch phase
            // (not after in-flight work settles); the worker self-heals after errors.
            self.scheduleNext();
        }
    }

    private async recordQueueDepth(self: EventQueueWorker): Promise<void> {
        try {
            const qp: any = self.queueProvider;
            if (typeof qp.getQueueLength === "function") {
                const depth = await qp.getQueueLength(QueueType.Event);
                self.metrics.recordGauge(METRIC_NAMES.QUEUE_DEPTH, depth, { [ATTR.QUEUE]: "event" });
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.log(LogLevel.Error, "Error recording event queue depth (ignored)", { err: error });
        }
    }

    private async processEvent(self: EventQueueWorker, eventId: string): Promise<void> {
        try {
            // M6: read the event up front (by globally-unique id) so its tenant is known,
            // then namespace the event lock by that tenant (§6.8). Two tenants can never
            // share a lock key for the same underlying id.
            let stored = await self.persistence.getEvent(eventId);
            if (!stored) {
                self.logger.log(LogLevel.Info, "Event not found", { eventId });
                return;
            }
            const tenantId = stored.tenantId || DEFAULT_TENANT;
            const eventLockKey = tenantLockKey(tenantId, eventId);
            const gotLock = await self.lockProvider.acquireLock(eventLockKey);
            if (gotLock) {
                try {
                    // H6: decode eventData after read so the plaintext payload is seeded into
                    // the workflow's execution pointer (below) and seen by the step body. Decode
                    // onto a shallow copy: a provider (e.g. MemoryPersistenceProvider) may return a
                    // live reference to the stored event, and decoding it in place would rewrite the
                    // at-rest bytes back to plaintext. The copy keeps the stored event encoded.
                    let evt = Object.assign(new Event(), stored);
                    await self.codecRunner.decodeEvent(evt);
                    if (evt.eventTime <= new Date())
                    {
                        // M6 §6.5: scope subscription matching by the event's tenant — the
                        // sole runtime enforcement point of cross-tenant isolation.
                        let subs = await self.persistence.getSubscriptions(tenantId, evt.eventName, evt.eventKey, evt.eventTime);
                        let success = true;

                        for (let sub of subs)
                            success = success && await self.seedSubscription(self, evt, sub);

                        if (success)
                            await self.persistence.markEventProcessed(eventId);
                    }

                }
                finally {
                    await self.lockProvider.releaseLock(eventLockKey);
                }
            }
            else {
                self.logger.log(LogLevel.Info, "Event locked", { eventId });
            }
        }
        catch (err) {
            const error = toError(err);
            self.logger.log(LogLevel.Error, "Error processing event", { eventId, err: error });
        }
    }

    private async seedSubscription(self: EventQueueWorker, evt: Event, sub: EventSubscription): Promise<boolean> {

        // M6 §6.8: namespace the workflow lock by the subscription's tenant.
        const wfLockKey = tenantLockKey(sub.tenantId || DEFAULT_TENANT, sub.workflowId);
        if (await self.lockProvider.acquireLock(wfLockKey)) {
            try {
                let workflow = await self.persistence.getWorkflowInstance(sub.workflowId);
                // H6: decode the workflow payload after read before mutating/persisting.
                await self.codecRunner.decodeInstance(workflow);
                let pointers = workflow.executionPointers.filter(p => p.eventName === sub.eventName && p.eventKey === sub.eventKey && !p.eventPublished);
                for (let p of pointers) {
                    p.eventData = evt.eventData;
                    p.eventPublished = true;
                    p.active = true;
                }
                workflow.nextExecution = 0;
                // H6: encode before persist, then restore plaintext on the in-memory instance.
                await self.codecRunner.encodeInstance(workflow);
                await self.persistence.persistWorkflow(workflow);
                await self.codecRunner.decodeInstance(workflow);
                await self.persistence.terminateSubscription(sub.id);
                // H2 (spec §6.8): re-queue while still holding the workflow lock,
                // so releaseLock (finally) is the last action; the re-queue occurs
                // exactly when seeding succeeded.
                await self.queueProvider.queueForProcessing(sub.workflowId, QueueType.Workflow);
                return true;
            }
            catch (err) {
                const error = toError(err);
                self.logger.log(LogLevel.Error, "Error seeding subscription", { workflowId: sub.workflowId, err: error });
                return false;
            }
            finally {
                await self.lockProvider.releaseLock(wfLockKey);
            }
        }
        else {
            self.logger.log(LogLevel.Info, "Workflow locked (event seed deferred)", { workflowId: sub.workflowId });
            return false;
        }
    }
}