import { injectable, inject, Container } from "inversify";
import { IPersistenceProvider, ILogger, IWorkflowRegistry, IWorkflowExecutor, TYPES, IExecutionResultProcessor, toError, WorkflowOptions, ILifecycleEventHub, WorkflowDeadLetteredEvent, WORKFLOW_DEAD_LETTERED, IMetrics, ITracer, ISpan, METRIC_NAMES, SPAN_NAMES, ATTR, MetricAttributes } from "../abstractions";
import { WorkflowHost } from "./workflow-host";
import { WorkflowInstance, WorkflowDefinition, ExecutionPointer, PointerStatus, ExecutionResult, StepExecutionContext, WorkflowStepBase, WorkflowStatus, ExecutionError, WorkflowErrorHandling, ExecutionPipelineDirective, WorkflowExecutorResult } from "../models";

@injectable()
export class WorkflowExecutor implements IWorkflowExecutor {

    @inject(TYPES.IWorkflowRegistry)
    private registry : IWorkflowRegistry;

    @inject(TYPES.IExecutionResultProcessor)
    private resultProcessor : IExecutionResultProcessor;

    @inject(TYPES.ILogger)
    private logger : ILogger;

    @inject(TYPES.WorkflowOptions)
    private options : WorkflowOptions;

    @inject(TYPES.ILifecycleEventHub)
    private lifecycle : ILifecycleEventHub;

    @inject(TYPES.IMetrics)
    private metrics : IMetrics;

    @inject(TYPES.ITracer)
    private tracer : ITracer;

    @inject(Container)
    private container : Container;
    
    public async execute(instance: WorkflowInstance): Promise<WorkflowExecutorResult> {

        let result: WorkflowExecutorResult = new WorkflowExecutorResult();
        
        this.logger.log("Execute workflow: " + instance.id);                

        let exePointers: Array<ExecutionPointer> = instance.executionPointers.filter(x => x.active);

        let def = this.registry.getDefinition(instance.workflowDefinitionId, instance.version);
        if (!def) {
            throw new Error(`No workflow definition in registry for ${instance.workflowDefinitionId}:${instance.version}`);
        }

        for (let pointer of exePointers) {
            let step: WorkflowStepBase = def.steps.find(x => x.id == pointer.stepId);
            if (step) {
                // M5 §6.4: count an existing retry attempt (does not change retry behaviour, that is H5).
                if (pointer.retryCount && pointer.retryCount > 0) {
                    this.safeMetric(() => this.metrics.incrementCounter(METRIC_NAMES.STEP_RETRIES, 1, {
                        [ATTR.WORKFLOW_DEFINITION_ID]: instance.workflowDefinitionId,
                        [ATTR.STEP_ID]: String(pointer.stepId),
                    }));
                }
                try {
                    pointer.status = PointerStatus.Running;
                    switch (step.initForExecution(result, def, instance, pointer)) {
                        case ExecutionPipelineDirective.Defer:
                            continue;
                        case ExecutionPipelineDirective.EndWorkflow:
                            instance.status = WorkflowStatus.Complete;
                            instance.completeTime = new Date();
                            continue;
                    }
                    
                    if (!pointer.startTime)
                        pointer.startTime = new Date();

                    //log starting step
                    let stepContext = new StepExecutionContext();
                    stepContext.persistenceData = pointer.persistenceData;
                    stepContext.step = step;
                    stepContext.workflow = instance;
                    stepContext.item = pointer.contextItem;
                    stepContext.pointer = pointer;
                    
                    let body =  this.container.resolve(step.body);

                    //inputs
                    for (let input of step.inputs) {
                        input(body, instance.data);
                    }
                    
                    switch (step.beforeExecute(result, stepContext, pointer, body)) {
                        case ExecutionPipelineDirective.Defer:
                            continue;
                        case ExecutionPipelineDirective.EndWorkflow:
                            instance.status = WorkflowStatus.Complete;                            
                            instance.completeTime = new Date();
                            continue;
                    }

                    //execute — M5 §6.1/§6.2: wrap body.run in a span and time it; the
                    // span ends and the duration histogram records on both success and failure.
                    const spanAttrs: MetricAttributes = {
                        [ATTR.WORKFLOW_ID]: instance.id,
                        [ATTR.STEP_ID]: String(step.id),
                        [ATTR.WORKFLOW_DEFINITION_ID]: instance.workflowDefinitionId,
                        [ATTR.WORKFLOW_VERSION]: instance.version,
                    };
                    if (step.name)
                        spanAttrs[ATTR.STEP_NAME] = step.name;
                    let span: ISpan = this.startSpanSafe(SPAN_NAMES.STEP_EXECUTE, spanAttrs);
                    const t0 = Date.now();
                    let stepResult;
                    try {
                        stepResult = await body.run(stepContext);
                    }
                    catch (runErr) {
                        this.safeSpan(() => span.recordError(toError(runErr)));
                        throw runErr;
                    }
                    finally {
                        this.safeMetric(() => this.metrics.recordHistogram(METRIC_NAMES.STEP_DURATION, Date.now() - t0, {
                            [ATTR.WORKFLOW_DEFINITION_ID]: instance.workflowDefinitionId,
                            [ATTR.STEP_ID]: String(step.id),
                        }));
                        this.safeSpan(() => span.end());
                    }

                    //outputs
                    for (let output of step.outputs) {
                        output(body, instance.data);
                    }

                    this.resultProcessor.processExecutionResult(stepResult, pointer, instance, step, result);
                }
                catch (err) {
                    const error = toError(err);
                    this.logger.error("Error executing workflow %s on step %s - %o", instance.id, pointer.stepId, error);
                    // M5 §6.3: one error counter increment per caught step error.
                    this.safeMetric(() => this.metrics.incrementCounter(METRIC_NAMES.STEP_ERRORS, 1, {
                        [ATTR.WORKFLOW_DEFINITION_ID]: instance.workflowDefinitionId,
                        [ATTR.STEP_ID]: String(pointer.stepId),
                    }));
                    let perr = new ExecutionError();
                    perr.message = error.message;
                    perr.errorTime = new Date();
                    result.errors.push(perr);

                    if (!pointer.persistenceData) {
                        pointer.persistenceData = {};
                    }
                    if (!Array.isArray(pointer.persistenceData._errors)) {
                        pointer.persistenceData._errors = [];
                    }
                    pointer.persistenceData._errors.push({
                        message: error.message,
                        stack: error.stack || null,
                        errorTime: new Date().toISOString(),
                        retryCount: pointer.retryCount || 0
                    });

                    this.resultProcessor.handleStepException(instance, def, pointer, step);
                }
            }
            else {
                this.logger.error("Could not find step on workflow %s %s", instance.id, pointer.stepId);
                // H5 (spec h5 §6.9): bounded, configurable. There is no step object to read
                // maxRetries from, so the global default budget applies; on exhaustion the
                // workflow dead-letters exactly as the Retry path does (spec h5 §6.5).
                if (pointer.retryCount >= this.options.retry.defaultMaxRetries) {
                    this.deadLetter(instance, pointer, this.options.retry.defaultMaxRetries);
                }
                else {
                    pointer.sleepUntil = (Date.now() + this.options.retry.stepNotFoundRetryIntervalMs);
                    pointer.retryCount++;
                }
            }
        }

        this.processAfterExecutionIteration(instance, def, result);
        this.determineNextExecutionTime(instance);
        return result;
    }

    /**
     * H5 (spec h5 §6.5/§6.9): terminal give-up action for the step-not-found path —
     * retire the pointer, move the workflow out of Runnable, emit exactly one
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

    processAfterExecutionIteration(workflow: WorkflowInstance, defintion: WorkflowDefinition, workflowResult: WorkflowExecutorResult) {
        let pointers = workflow.executionPointers.filter(x => !x.endTime);

        for (let pointer of pointers) {
            let step = defintion.steps.find(x => x.id == pointer.stepId);
            if (step)
                step.afterWorkflowIteration(workflowResult, defintion, workflow, pointer);
        }
    }

    determineNextExecutionTime(instance: WorkflowInstance) {
        instance.nextExecution = null;

        if (instance.status == WorkflowStatus.Complete)
            return;

        // H5 (spec h5 §6.10): a dead-lettered instance is terminal — never schedule it
        // again, and never let the "all pointers ended" branch below flip it to Complete.
        if (instance.status == WorkflowStatus.DeadLettered)
            return;

        for (let pointer of instance.executionPointers.filter(x => x.active && x.children.length == 0)) {
            if (!pointer.sleepUntil) {
                instance.nextExecution = 0;
                return;
            }
            instance.nextExecution = Math.min(pointer.sleepUntil, instance.nextExecution ? instance.nextExecution : pointer.sleepUntil);
        }
        
        if (instance.nextExecution === null) {            
            for (let pointer of instance.executionPointers.filter(x => x.active && x.children.length > 0)) {
                
                if (!instance.executionPointers.filter(x => x.scope.includes(pointer.id)).every(x => !!x.endTime)) 
                    continue;
                
                if (!pointer.sleepUntil) {
                    instance.nextExecution = 0;
                    return;
                }
                instance.nextExecution = Math.min(pointer.sleepUntil, instance.nextExecution ? instance.nextExecution : pointer.sleepUntil);
            }            
        }

        if ((instance.nextExecution === null) && (instance.executionPointers.every(x => Boolean(x.endTime)))) {
            instance.completeTime = new Date();
            instance.status = WorkflowStatus.Complete;
        }
    }

    /**
     * M5 §6.13: telemetry MUST NOT break execution. A throwing metrics/tracer
     * call is caught and logged; it never escapes the step.
     */
    private safeMetric(fn: () => void): void {
        try { fn(); }
        catch (err) { this.logger.error("Metrics call failed (ignored): " + toError(err).message); }
    }

    private safeSpan(fn: () => void): void {
        try { fn(); }
        catch (err) { this.logger.error("Tracer call failed (ignored): " + toError(err).message); }
    }

    private startSpanSafe(name: string, attributes: MetricAttributes): ISpan {
        try {
            return this.tracer.startSpan(name, attributes);
        }
        catch (err) {
            this.logger.error("Tracer.startSpan failed (ignored): " + toError(err).message);
            return { setAttribute() {}, recordError() {}, end() {} };
        }
    }
}