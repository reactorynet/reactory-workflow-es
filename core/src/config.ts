import "reflect-metadata";
import { Container, ContainerModule, interfaces, injectable, inject } from "inversify";
import { TYPES, IWorkflowRegistry, IQueueProvider, IWorkflowHost, IPersistenceProvider, IDistributedLockProvider, IWorkflowExecutor, IBackgroundWorker, IExecutionResultProcessor, IExecutionPointerFactory, ILogger, LogLevel, WorkflowOptions, DEFAULT_POLL_INTERVAL_MS, DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS, ILifecycleEventHub, LifecycleEvent, IMetrics, ITracer, IDataCodec } from "./abstractions";
import { SingleNodeQueueProvider, SingleNodeLockProvider, MemoryPersistenceProvider, WorkflowExecutor, WorkflowQueueWorker, EventQueueWorker, PollWorker, WorkflowRegistry, WorkflowHost, ExecutionResultProcessor, ExecutionPointerFactory, NullLogger, ConsoleLogger, LifecycleEventHub, NoOpMetrics, NoOpTracer, NullDataCodec, DataCodecRunner } from "./services";

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

    // H5 — retry budget and intervals (consumed by ExecutionResultProcessor / WorkflowExecutor).
    // maxRetries counts retries AFTER the first attempt, so 0 (fail fast, no retries) is valid.
    const defaultMaxRetries = partial?.retry?.defaultMaxRetries ?? 3;
    if (!Number.isInteger(defaultMaxRetries) || defaultMaxRetries < 0) {
        throw new Error(`Invalid retry.defaultMaxRetries ${String(defaultMaxRetries)}: must be a finite integer >= 0.`);
    }
    const defaultRetryIntervalMs = requirePositiveInteger("retry.defaultRetryIntervalMs", partial?.retry?.defaultRetryIntervalMs ?? 60000);
    const stepNotFoundRetryIntervalMs = requirePositiveInteger("retry.stepNotFoundRetryIntervalMs", partial?.retry?.stepNotFoundRetryIntervalMs ?? 60000);

    // M10 — definition-fingerprint enforcement. Defaults to "enforce": instances predating
    // fingerprinting carry none and are exempt, so the strict default cannot retroactively
    // dead-letter existing work — it only refuses to run an instance against a graph that
    // provably changed under it.
    const definitionFingerprintMode = partial?.definitionFingerprintMode ?? "enforce";
    if (definitionFingerprintMode !== "enforce" && definitionFingerprintMode !== "warn" && definitionFingerprintMode !== "off") {
        throw new Error(
            `Invalid definitionFingerprintMode ${String(definitionFingerprintMode)}: must be "enforce", "warn" or "off".`
        );
    }

    // Remaining fields are declared but not yet consumed by their owning items (H6).
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
            defaultMaxRetries,
            defaultRetryIntervalMs,
            stepNotFoundRetryIntervalMs,
        },
        dataCodecMaxBytes: partial?.dataCodecMaxBytes ?? 0,
        definitionFingerprintMode,
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

    /**
     * M4 — convenience: bind a ConsoleLogger at the given minimum level.
     * Equivalent to useLogger(new ConsoleLogger(level)).
     * Default level is Info (same as new ConsoleLogger() with no argument).
     */
    public useConsoleLogger(level: LogLevel = LogLevel.Info) {
        this.container.rebind<ILogger>(TYPES.ILogger).toConstantValue(new ConsoleLogger(level));
    }

    /**
     * M5 — swap the metrics facade (plan §8.1: a swappable service gets a useX() setter).
     * The default NoOpMetrics discards everything, so core stays zero-dependency and emits
     * nothing until an adapter (e.g. @reactorynet/workflow-es-opentelemetry) is injected.
     */
    public useMetrics(service: IMetrics) {
        this.container.rebind<IMetrics>(TYPES.IMetrics).toConstantValue(service);
    }

    /**
     * M5 — swap the tracer facade. The default NoOpTracer returns a no-op span, so core
     * has zero tracing dependency until an adapter is injected.
     */
    public useTracer(service: ITracer) {
        this.container.rebind<ITracer>(TYPES.ITracer).toConstantValue(service);
    }

    /**
     * H6 — swap the at-rest data codec (plan §8.1: an implementation gets a useX() setter).
     * The default NullDataCodec is a no-op (plaintext at rest). Binding an encrypting/redacting
     * codec transforms WorkflowInstance.data and Event.eventData before they reach any provider
     * and restores them after read — with no provider source change.
     */
    public useDataCodec(service: IDataCodec) {
        this.container.rebind<IDataCodec>(TYPES.IDataCodec).toConstantValue(service);
    }

    /**
     * H6 — override the optional plaintext size guard (bytes; 0 = unlimited). The default is
     * seeded from WorkflowOptions.dataCodecMaxBytes at configureWorkflow() time; this setter
     * lets a consumer change it imperatively. Measured on the UTF-8 JSON length of the plaintext
     * payload before encode; an oversized payload throws at the persist/publish boundary.
     */
    public useDataCodecSizeLimit(maxPayloadBytes: number) {
        this.container.get<DataCodecRunner>(DataCodecRunner).maxPayloadBytes = maxPayloadBytes;
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

    /**
     * H5 — swap the lifecycle event hub implementation (plan §8.1: an implementation
     * gets a useX() setter). The default LifecycleEventHub is a no-op until a handler
     * is registered.
     */
    public useLifecycleEventHub(service: ILifecycleEventHub) {
        this.container.rebind<ILifecycleEventHub>(TYPES.ILifecycleEventHub).toConstantValue(service);
    }

    /**
     * H5 — convenience: subscribe a handler to engine lifecycle events
     * (currently only `workflow.dead-lettered`) on the bound hub.
     */
    public onLifecycleEvent(handler: (evt: LifecycleEvent) => void) {
        this.container.get<ILifecycleEventHub>(TYPES.ILifecycleEventHub).on(handler);
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
        bind<ILifecycleEventHub>(TYPES.ILifecycleEventHub).to(LifecycleEventHub).inSingletonScope();
        bind<IMetrics>(TYPES.IMetrics).to(NoOpMetrics).inSingletonScope();
        bind<ITracer>(TYPES.ITracer).to(NoOpTracer).inSingletonScope();

        // H6 — at-rest codec seam. Default is the no-op NullDataCodec, so unconfigured
        // hosts (desktop/dev) persist plaintext with zero behaviour change. The runner is
        // the single core boundary that applies the bound codec (+ optional size guard).
        bind<IDataCodec>(TYPES.IDataCodec).to(NullDataCodec).inSingletonScope();
        bind<DataCodecRunner>(DataCodecRunner).toSelf().inSingletonScope();

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