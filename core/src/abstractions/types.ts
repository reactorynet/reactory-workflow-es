let TYPES = {
    IWorkflowRegistry: Symbol("IWorkflowRegistry"),
    IWorkflowHost: Symbol("IWorkflowHost"),
    IDistributedLockProvider: Symbol("IDistributedLockProvider"),
    ILogger: Symbol("ILogger"),
    IPersistenceProvider: Symbol("IPersistenceProvider"),
    IQueueProvider: Symbol("IQueueProvider"),
    IBackgroundWorker: Symbol("IBackgroundWorker"),
    IWorkflowExecutor: Symbol("IWorkflowExecutor"),
    IExecutionResultProcessor: Symbol("IExecutionResultProcessor"),
    IExecutionPointerFactory: Symbol("IExecutionPointerFactory"),
    WorkflowOptions: Symbol("WorkflowOptions"),
    ILifecycleEventHub: Symbol("ILifecycleEventHub"),
    IMetrics: Symbol("IMetrics"),
    ITracer: Symbol("ITracer"),
    IDataCodec: Symbol("IDataCodec"),
};

export { TYPES };

/**
 * M6 — multi-tenancy sentinel. When a host caller omits `tenantId`, the engine
 * stamps this value on the created WorkflowInstance/Event/EventSubscription so
 * single-tenant / Electron deployments behave exactly as before. It is a plain
 * exported constant, NOT a configurable value (no `configureWorkflow` option).
 */
export const DEFAULT_TENANT = "default";