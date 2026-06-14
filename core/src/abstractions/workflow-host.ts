import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription } from "../models";
import { WorkflowBase, IPersistenceProvider, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger } from "../abstractions";
import { LifecycleEvent } from "./lifecycle-events";
import { HealthReport } from "./health";

export interface IWorkflowHost {
    start(): Promise<void>;
    /**
     * Graceful shutdown. Stops intake on all workers, awaits in-flight
     * executions up to the configured `gracefulShutdownTimeoutMs` (default
     * 30000), removes the registered process signal handlers, and resolves.
     * Idempotent: a second call resolves immediately (concurrent calls share
     * the same drain). Safe to call from an Electron quit handler, e.g.
     * `app.on('before-quit', async (e) => { e.preventDefault(); await host.stop(); app.exit(); })`.
     */
    stop(): Promise<void>;
    /**
     * Start a workflow instance. M6: `tenantId` is OPTIONAL and defaults to
     * "default" (DEFAULT_TENANT); existing 3-arg callers are unaffected. The
     * tenant is stamped onto the created WorkflowInstance.
     */
    startWorkflow(id: string, version: number, data: any, tenantId?: string): Promise<string>;
    registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>): void;
    /**
     * Publish an external event. M6: `tenantId` is OPTIONAL and defaults to
     * "default"; the event only wakes subscriptions in the same tenant.
     */
    publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date, tenantId?: string): Promise<void>;
    suspendWorkflow(id: string): Promise<boolean>;
    resumeWorkflow(id: string): Promise<boolean>;
    terminateWorkflow(id: string): Promise<boolean>;
    /**
     * H5 — subscribe to engine lifecycle events (currently only
     * `workflow.dead-lettered`). Handlers are invoked synchronously and
     * best-effort: a throwing handler is swallowed and never affects engine
     * state. Delegates to the injected ILifecycleEventHub.
     */
    onLifecycleEvent(handler: (evt: LifecycleEvent) => void): void;
    /**
     * Produce a point-in-time health report: probes the persistence, lock, and queue
     * providers (via the optional IHealthProbe), reports active workflow count and the
     * poll-worker heartbeat, and computes the worst-of aggregate status. Never throws.
     */
    health(): Promise<HealthReport>;
}