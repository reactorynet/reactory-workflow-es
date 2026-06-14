import { injectable, inject } from "inversify";
import { IPersistenceProvider, ILogger, IWorkflowRegistry, IWorkflowExecutor, TYPES, IExecutionResultProcessor, IExecutionPointerFactory, WorkflowOptions, ILifecycleEventHub, WorkflowDeadLetteredEvent, WORKFLOW_DEAD_LETTERED, DEFAULT_TENANT } from "../abstractions";
import { WorkflowHost } from "./workflow-host";
import { WorkflowInstance, ExecutionPointer, PointerStatus, ExecutionResult, WorkflowDefinition, StepExecutionContext, WorkflowStepBase, WorkflowStatus, ExecutionError, WorkflowErrorHandling, ExecutionPipelineDirective, WorkflowExecutorResult, EventSubscription } from "../models";
const isNullOrUndefined = (val: any): val is null | undefined => val === null || val === undefined;

@injectable()
export class ExecutionResultProcessor implements IExecutionResultProcessor {
    
    @inject(TYPES.IExecutionPointerFactory)
    private pointerFactory : IExecutionPointerFactory;

    @inject(TYPES.ILogger)
    private logger : ILogger;

    @inject(TYPES.WorkflowOptions)
    private options : WorkflowOptions;

    @inject(TYPES.ILifecycleEventHub)
    private lifecycle : ILifecycleEventHub;

    public processExecutionResult(stepResult: ExecutionResult, pointer: ExecutionPointer, instance: WorkflowInstance, step: WorkflowStepBase, workflowResult: WorkflowExecutorResult) {

        pointer.persistenceData = stepResult.persistenceData;
        pointer.outcome = stepResult.outcomeValue;
        if (stepResult.sleep) {
            pointer.sleepUntil = stepResult.sleep.getTime();
            pointer.status = PointerStatus.Sleeping;
        }

        if (stepResult.eventName) {
            pointer.eventName = stepResult.eventName;
            pointer.eventKey = stepResult.eventKey;
            pointer.active = false;
            pointer.status = PointerStatus.WaitingForEvent;

            let subscription = new EventSubscription();
            // M6: inherit the tenant of the owning instance so subscription matching
            // stays tenant-scoped (defaults to "default" for single-tenant flows).
            subscription.tenantId = instance.tenantId || DEFAULT_TENANT;
            subscription.workflowId = instance.id;
            subscription.stepId = pointer.stepId;
            subscription.eventName = pointer.eventName;
            subscription.eventKey = pointer.eventKey;
            subscription.subscribeAsOf = stepResult.eventAsOf;

            workflowResult.subscriptions.push(subscription);
        }

        if (stepResult.proceed) {
            pointer.active = false;
            pointer.status = PointerStatus.Complete;
            pointer.endTime = new Date();
            
            for (let outcome of step.outcomes.filter(x => (x.value(instance.data) == stepResult.outcomeValue) || (x.value(instance.data) == null))) {
                let newPointer = this.pointerFactory.buildNextPointer(pointer, outcome);                
                instance.executionPointers.push(newPointer);
            }
        }
        else {
            for (let branch of stepResult.branchValues) {
                for (let childDefId of step.children) {                    
                    let childPointer = this.pointerFactory.buildChildPointer(pointer, childDefId, branch);
                    instance.executionPointers.push(childPointer);
                }
            }
        }
    }

    public handleStepException(workflow: WorkflowInstance, definition: WorkflowDefinition, pointer: ExecutionPointer, step: WorkflowStepBase) {
        pointer.status = PointerStatus.Failed;            
        let errorOption = step.errorBehavior;
        if (!errorOption) {
            if (this.shouldCompensate(workflow, definition, pointer))
                errorOption = WorkflowErrorHandling.Compensate;
            else
                errorOption = definition.errorBehavior;
        }
        this.selectErrorStrategy(errorOption, workflow, definition, pointer, step);
    }

    private selectErrorStrategy(errorOption: number, workflow: WorkflowInstance, definition: WorkflowDefinition, pointer: ExecutionPointer, step: WorkflowStepBase) {

        switch (errorOption) {
            case WorkflowErrorHandling.Retry: {
                // H5 (spec h5 §6.1/.2): finite retry budget — maxRetries is the number of
                // re-tries allowed AFTER the first attempt (total attempts = maxRetries + 1).
                const maxRetries = this.resolveMaxRetries(step, definition);
                if (pointer.retryCount >= maxRetries) {
                    this.deadLetter(workflow, pointer, maxRetries);
                    return; // terminal: skip retryCount++ (spec h5 §6.5)
                }
                pointer.sleepUntil = (Date.now() + this.resolveRetryInterval(step));
                step.primeForRetry(pointer);
                break;
            }
            case WorkflowErrorHandling.Suspend:
                workflow.status = WorkflowStatus.Suspended;
                break;
            case WorkflowErrorHandling.Terminate:
                workflow.status = WorkflowStatus.Terminated;
                break;
            case WorkflowErrorHandling.Compensate:
                this.compensate(workflow, definition, pointer);
                break;
            default: {
                // H5 (spec h5 §6.4): unrecognised errorBehavior is budgeted like Retry,
                // using the configured default interval (replaces the 60000 literal).
                const maxRetries = this.resolveMaxRetries(step, definition);
                if (pointer.retryCount >= maxRetries) {
                    this.deadLetter(workflow, pointer, maxRetries);
                    return;
                }
                pointer.sleepUntil = (Date.now() + this.options.retry.defaultRetryIntervalMs);
                break;
            }
        }

        pointer.retryCount++;
    }

    /**
     * H5 (spec h5 §5.2): maxRetries precedence — step → definition → WorkflowOptions.retry.defaultMaxRetries.
     */
    private resolveMaxRetries(step: WorkflowStepBase, definition: WorkflowDefinition): number {
        return step.maxRetries ?? definition.maxRetries ?? this.options.retry.defaultMaxRetries;
    }

    /**
     * H5 (spec h5 §6.3): step.retryInterval if it is a finite number > 0, else the configured
     * default. Fixes the latent `Date.now() + null` bug when onError(Retry) is called with no interval.
     */
    private resolveRetryInterval(step: WorkflowStepBase): number {
        if (typeof step.retryInterval === "number" && Number.isFinite(step.retryInterval) && step.retryInterval > 0)
            return step.retryInterval;
        return this.options.retry.defaultRetryIntervalMs;
    }

    /**
     * H5 (spec h5 §6.5): terminal give-up action — retire the pointer, move the whole
     * workflow out of Runnable (mirrors Suspended/Terminated, so the queue worker and
     * getRunnableInstances() stop picking it up), and emit exactly one
     * `workflow.dead-lettered` lifecycle event.
     */
    private deadLetter(workflow: WorkflowInstance, pointer: ExecutionPointer, maxRetries: number) {
        pointer.active = false;
        pointer.status = PointerStatus.DeadLettered;
        if (!pointer.endTime)
            pointer.endTime = new Date();
        workflow.status = WorkflowStatus.DeadLettered;

        const errors = pointer.persistenceData && Array.isArray(pointer.persistenceData._errors)
            ? pointer.persistenceData._errors
            : [];
        const lastError = errors.length > 0 ? errors[errors.length - 1] : null;

        const evt: WorkflowDeadLetteredEvent = {
            event: WORKFLOW_DEAD_LETTERED as "workflow.dead-lettered",
            workflowId: workflow.id,
            workflowDefinitionId: workflow.workflowDefinitionId,
            version: workflow.version,
            pointerId: pointer.id,
            stepId: pointer.stepId,
            retryCount: pointer.retryCount,
            maxRetries: maxRetries,
            errorMessage: lastError && lastError.message ? lastError.message : null,
            deadLetteredAt: new Date().toISOString()
        };

        this.logger.error("Workflow %s dead-lettered on step %s after %s retries (maxRetries %s)", workflow.id, pointer.stepId, pointer.retryCount, maxRetries);
        this.lifecycle.emit(evt);
    }

    private compensate(workflow: WorkflowInstance, definition: WorkflowDefinition, exceptionPointer: ExecutionPointer) {
        let scope: string[] = [];
        if (exceptionPointer.scope)
            scope = exceptionPointer.scope.slice();
        
        scope.push(exceptionPointer.id);

        while (scope.length > 0) {
            let pointerId = scope.pop();
            let pointer = workflow.executionPointers.find(x => x.id == pointerId);
            let step = definition.steps.find(x => x.id == pointer.stepId);

            let resume = true;
            let revert = false;

            let txnStack = scope.slice();

            while (txnStack.length > 0) {
                let parentId = txnStack.pop();
                let parentPointer = workflow.executionPointers.find(x => x.id == parentId);
                let parentStep = definition.steps.find(x => x.id == parentPointer.stepId);

                if ((!parentStep.resumeChildrenAfterCompensation()) || (parentStep.revertChildrenAfterCompensation())) {
                    resume = parentStep.resumeChildrenAfterCompensation();
                    revert = parentStep.revertChildrenAfterCompensation();
                }
            }

            let errorBehavior = this.isNull(step.errorBehavior, WorkflowErrorHandling.Compensate);
            
            if (errorBehavior != WorkflowErrorHandling.Compensate) {
                this.selectErrorStrategy(this.isNull(step.errorBehavior, WorkflowErrorHandling.Retry), workflow, definition, pointer, step);
                continue;
            }

            exceptionPointer.active = false;
            exceptionPointer.endTime = new Date();
            exceptionPointer.status = PointerStatus.Failed;

            if (!isNullOrUndefined(step.compensationStepId)) {
                pointer.status = PointerStatus.Compensated;
                // Deactivate the compensated pointer so the normal completion path (e.g. a Sequence
                // container detecting its children are done) does not ALSO emit its outcome — the
                // resume block below is the single source of the post-compensation next pointer.
                pointer.active = false;
                if (!pointer.endTime)
                    pointer.endTime = new Date();

                let compensationPointer = this.pointerFactory.buildCompensationPointer(pointer, exceptionPointer, step.compensationStepId);
                workflow.executionPointers.push(compensationPointer);
                
                if (resume) {
                    for (let outcomeTarget of step.outcomes.filter(x => isNullOrUndefined(x.value(workflow.data))))
                        workflow.executionPointers.push(this.pointerFactory.buildNextPointer(pointer, outcomeTarget));
                }
            }

            if (revert) {
                let prevSiblings = workflow.executionPointers.filter(x => JSON.stringify(pointer.scope) == JSON.stringify(x.scope) && x.id != pointer.id && x.status == PointerStatus.Complete);
                for (let siblingPointer of prevSiblings) {
                    let siblingStep = definition.steps.find(x => x.id == siblingPointer.stepId);
                    if (!isNullOrUndefined(siblingStep.compensationStepId)) {
                        var compensationPointer = this.pointerFactory.buildCompensationPointer(siblingPointer, exceptionPointer, siblingStep.compensationStepId);
                        workflow.executionPointers.push(compensationPointer);
                        siblingPointer.status = PointerStatus.Compensated;
                    }
                }
            }
        }
    }

    private shouldCompensate(workflow: WorkflowInstance, definition: WorkflowDefinition, currentPointer: ExecutionPointer): boolean {
        let scope: string[] = [];
        if (currentPointer.scope)
            scope = currentPointer.scope.slice();
        
        scope.push(currentPointer.id);

        while (scope.length > 0)
        {
            let pointerId = scope.pop();
            let pointer = workflow.executionPointers.find(x => x.id == pointerId);
            let step = definition.steps.find(x => x.id == pointer.stepId);
            if (step.revertChildrenAfterCompensation)
                return true;
            if ((step.compensationStepId !== undefined) && (step.compensationStepId !== null))
                return true;
        }

        return false;
    }

    private isNull(obj: any, fallback: any): any {
        if (isNullOrUndefined(obj))
            return fallback;
        return obj;
    }
 
}