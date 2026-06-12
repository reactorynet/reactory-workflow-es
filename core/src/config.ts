import "reflect-metadata";
import { Container, ContainerModule, interfaces, injectable, inject } from "inversify";
import { TYPES, IWorkflowRegistry, IQueueProvider, IWorkflowHost, IPersistenceProvider, IDistributedLockProvider, IWorkflowExecutor, IBackgroundWorker, IExecutionResultProcessor, IExecutionPointerFactory, ILogger, WorkflowOptions, DEFAULT_POLL_INTERVAL_MS, DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS } from "./abstractions";
import { SingleNodeQueueProvider, SingleNodeLockProvider, MemoryPersistenceProvider, WorkflowExecutor, WorkflowQueueWorker, EventQueueWorker, PollWorker, WorkflowRegistry, WorkflowHost, ExecutionResultProcessor, ExecutionPointerFactory, NullLogger, ConsoleLogger } from "./services";

/**
 * Resolve caller-supplied partial options against defaults, validating each field that
 * H1/H3 (and future items) consume. Throws synchronously at configuration time on invalid values.
 */
function resolveOptions(partial?: Partial<WorkflowOptions>): WorkflowOptions {
    const pollIntervalMs = partial?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000) {
        throw new Error(
            `Invalid pollIntervalMs ${String(pollIntervalMs)}: must be a finite integer >= 1000 (ms).`
        );
    }

    // H1 — bounded queue-worker pools: caps and re-poll intervals must be finite integers >= 1.
    const requirePositiveInteger = (field: string, value: number): number => {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`Invalid ${field} ${String(value)}: must be a finite integer >= 1.`);
        }
        return value;
    };
    const workflowQueueIntervalMs = requirePositiveInteger("workflowQueueIntervalMs", partial?.workflowQueueIntervalMs ?? 100);
    const eventQueueIntervalMs = requirePositiveInteger("eventQueueIntervalMs", partial?.eventQueueIntervalMs ?? 500);
    const maxConcurrentWorkflows = requirePositiveInteger("maxConcurrentWorkflows", partial?.maxConcurrentWorkflows ?? 10);
    const maxConcurrentEvents = requirePositiveInteger("maxConcurrentEvents", partial?.maxConcurrentEvents ?? 20);

    // Remaining fields are declared but not yet consumed by their owning items (H5/H6).
    // Defaults are applied here so the interface is stable and downstream items can wire them
    // without changing this function's signature.
    return {
        pollIntervalMs,
        workflowQueueIntervalMs,
        eventQueueIntervalMs,
        maxConcurrentWorkflows,
        maxConcurrentEvents,
        // H4: 0 is permitted (force stop immediately); negative / non-finite values
        // fall back to the default at stop() time with a logged warning (spec H4 §5).
        gracefulShutdownTimeoutMs: partial?.gracefulShutdownTimeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        retry: {
            defaultMaxRetries: partial?.retry?.defaultMaxRetries ?? 3,
            defaultRetryIntervalMs: partial?.retry?.defaultRetryIntervalMs ?? 60000,
            stepNotFoundRetryIntervalMs: partial?.retry?.stepNotFoundRetryIntervalMs ?? 60000,
        },
        dataCodecMaxBytes: partial?.dataCodecMaxBytes ?? 0,
    };
}

export class WorkflowConfig {
    private container: Container;
    private allowSingleNode: boolean = false;

    constructor(container: Container) {
        this.container = container;
    }

    public getContainer(): Container {
        return this.container;
    }

    /**
     * Escape hatch (default false). When false, WorkflowHost.start() fails loud if a
     * non-memory persistence provider is configured while the lock or queue is still a
     * single-node (dev-only) default. Set true to override (e.g. a deliberate
     * single-process deployment with a durable persistence provider). See spec C1 §6.9.
     */
    public allowSingleNodeProviders(allow: boolean = true) {
        this.allowSingleNode = allow;
    }

    public useLogger(service: ILogger) {
        this.container.rebind<ILogger>(TYPES.ILogger).toConstantValue(service);
    }

    public usePersistence(service: IPersistenceProvider) {
        this.container.rebind<IPersistenceProvider>(TYPES.IPersistenceProvider).toConstantValue(service);
    }

    public useQueueManager(service: IQueueProvider) {
        this.container.rebind<IQueueProvider>(TYPES.IQueueProvider).toConstantValue(service);
    }

    public useLockManager(service: IDistributedLockProvider) {        
        this.container.rebind<IDistributedLockProvider>(TYPES.IDistributedLockProvider).toConstantValue(service);        
    }

    public getHost(): IWorkflowHost {
        let host = this.container.get<IWorkflowHost>(TYPES.IWorkflowHost);
        if (typeof (host as any).setAllowSingleNodeProviders === "function") {
            (host as any).setAllowSingleNodeProviders(this.allowSingleNode);
        }
        return host;
    }
}

export function configureWorkflow(options?: Partial<WorkflowOptions>): WorkflowConfig {
    const resolved = resolveOptions(options);

    let workflowModule = new ContainerModule((bind: interfaces.Bind, unbind: interfaces.Unbind) => {
        bind<WorkflowOptions>(TYPES.WorkflowOptions).toConstantValue(resolved);

        bind<ILogger>(TYPES.ILogger).to(NullLogger);
        bind<IQueueProvider>(TYPES.IQueueProvider).to(SingleNodeQueueProvider).inSingletonScope();
        bind<IPersistenceProvider>(TYPES.IPersistenceProvider).to(MemoryPersistenceProvider).inSingletonScope();
        bind<IDistributedLockProvider>(TYPES.IDistributedLockProvider).to(SingleNodeLockProvider).inSingletonScope();
        bind<IWorkflowRegistry>(TYPES.IWorkflowRegistry).to(WorkflowRegistry).inSingletonScope();
        bind<IWorkflowExecutor>(TYPES.IWorkflowExecutor).to(WorkflowExecutor);
        bind<IExecutionResultProcessor>(TYPES.IExecutionResultProcessor).to(ExecutionResultProcessor);
        bind<IExecutionPointerFactory>(TYPES.IExecutionPointerFactory).to(ExecutionPointerFactory);

        bind<IBackgroundWorker>(TYPES.IBackgroundWorker).to(WorkflowQueueWorker);
        bind<IBackgroundWorker>(TYPES.IBackgroundWorker).to(EventQueueWorker);
        bind<IBackgroundWorker>(TYPES.IBackgroundWorker).to(PollWorker);

        bind<IWorkflowHost>(TYPES.IWorkflowHost).to(WorkflowHost).inSingletonScope();
    });

    let container = new Container();
    container.bind(Container).toConstantValue(container);
    container.load(workflowModule);

    let config = new WorkflowConfig(container);
    return config;
}