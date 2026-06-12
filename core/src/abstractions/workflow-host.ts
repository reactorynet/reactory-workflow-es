import { WorkflowInstance, WorkflowStatus, ExecutionPointer, EventSubscription } from "../models";
import { WorkflowBase, IPersistenceProvider, IQueueProvider, IDistributedLockProvider, IWorkflowExecutor, ILogger } from "../abstractions";
import { LifecycleEvent } from "./lifecycle-events";

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
    startWorkflow(id: string, version: number, data: any): Promise<string>;    
    registerWorkflow<TData>(workflow: new () => WorkflowBase<TData>): void;
    publishEvent(eventName: string, eventKey: string, eventData: any, eventTime: Date): Promise<void>;
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
}