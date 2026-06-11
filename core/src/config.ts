import "reflect-metadata";
import { Container, ContainerModule, interfaces, injectable, inject } from "inversify";
import { TYPES, IWorkflowRegistry, IQueueProvider, IWorkflowHost, IPersistenceProvider, IDistributedLockProvider, IWorkflowExecutor, IBackgroundWorker, IExecutionResultProcessor, IExecutionPointerFactory, ILogger } from "./abstractions";
import { SingleNodeQueueProvider, SingleNodeLockProvider, MemoryPersistenceProvider, WorkflowExecutor, WorkflowQueueWorker, EventQueueWorker, PollWorker, WorkflowRegistry, WorkflowHost, ExecutionResultProcessor, ExecutionPointerFactory, NullLogger, ConsoleLogger } from "./services";

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

export function configureWorkflow(): WorkflowConfig {
    let workflowModule = new ContainerModule((bind: interfaces.Bind, unbind: interfaces.Unbind) => {        
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