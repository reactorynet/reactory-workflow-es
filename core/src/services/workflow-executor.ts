import { injectable, inject, Container } from "inversify";
import { IPersistenceProvider, ILogger, LogLevel, IWorkflowRegistry, IWorkflowExecutor, TYPES, IExecutionResultProcessor, toError, WorkflowOptions, ILifecycleEventHub, WorkflowDeadLetteredEvent, WORKFLOW_DEAD_LETTERED, IMetrics, ITracer, ISpan, METRIC_NAMES, SPAN_NAMES, ATTR, MetricAttributes } from "../abstractions";
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
        
        this.logger.log(LogLevel.Info, "Execute workflow", { workflowId: instance.id, tenantId: instance.tenantId });

        let exePointers: Array<ExecutionPointer> = instance.executionPointers.filter(x => x.active);

        // M1 — use the non-throwing variant; a missing (id, version) pair is dead-lettered
        // cleanly instead of propagating an exception and looping forever.
        let def = this.registry.tryGetDefinition(instance.workflowDefinitionId, instance.version);
        if (!def) {
            this.deadLetterMissingDefinition(instance, result);
            return result;
        }

        // M10 — the registered definition resolved, but is it the SAME GRAPH this
        // instance started on? Pointers address steps by ordinal index, so a definition
        // edited without a version bump silently remaps every suspended pointer.
        if (this.isDefinitionFingerprintMismatch(instance, def)) {
            if (this.options.definitionFingerprintMode === "enforce") {
                this.deadLetterChangedDefinition(instance, def, result);
                return result;
            }
            // "warn": execute anyway, but make the hazard loud and attributable.
            this.logger.log(LogLevel.Error, "Workflow definition changed under a running instance — executing anyway (definitionFingerprintMode=warn)", {
                workflowId: instance.id,
                workflowDefinitionId: instance.workflowDefinitionId,
                version: instance.version,
                startedFingerprint: instance.definitionFingerprint,
                registeredFingerprint: def.fingerprint,
                tenantId: instance.tenantId,
            });
        }

        for (let pointer of exePointers) {
            let step: WorkflowStepBase = def.steps.find(x => x.id == pointer.stepId);
            if (step) {
                // M5 §6.4: count an existing retry attempt (does not change retry behaviour, that is H5).
                // P4.3: `pointer.retryCount > 0` alone is sufficient — undefined/0/negative are all falsy or fail the check.
                if (pointer.retryCount > 0) {
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
                        input(body, instance.data, stepContext);
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
                        output(body, instance.data, stepContext);
                    }

                    this.resultProcessor.processExecutionResult(stepResult, pointer, instance, step, result);
                }
                catch (err) {
                    const error = toError(err);
                    this.logger.log(LogLevel.Error, "Error executing workflow step", { workflowId: instance.id, stepId: String(pointer.stepId), err: error, tenantId: instance.tenantId });
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
                this.logger.log(LogLevel.Error, "Could not find step on workflow", { workflowId: instance.id, stepId: String(pointer.stepId), tenantId: instance.tenantId });
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
     * M10 — Does this instance's pinned fingerprint disagree with the registered graph?
     *
     * Returns false (no mismatch) whenever the comparison cannot be made:
     *  - mode is "off";
     *  - the instance carries no fingerprint — it was started before fingerprinting
     *    existed, and such instances MUST keep running (spec M10 §6.3);
     *  - the definition carries no fingerprint — it was built by an older
     *    `WorkflowBuilder.build(id, version)` overload.
     *
     * Only two present-and-differing values count as a mismatch. Treating an absent
     * value as a mismatch would dead-letter every legacy instance on upgrade.
     */
    private isDefinitionFingerprintMismatch(instance: WorkflowInstance, def: WorkflowDefinition): boolean {
        if (this.options.definitionFingerprintMode === "off") return false;
        if (!instance.definitionFingerprint) return false;
        if (!def.fingerprint) return false;
        return instance.definitionFingerprint !== def.fingerprint;
    }

    /**
     * M10 — Dead-letter an instance whose definition graph changed underneath it.
     *
     * Not retryable: re-running would reproduce the mismatch every cycle, and the
     * remedy is an operator action (restore the graph, or publish the edit under a new
     * version). Mirrors `deadLetterMissingDefinition` — same terminal states, same
     * single `workflow.dead-lettered` lifecycle event — because to an operator this is
     * the same class of failure: the definition this instance needs is not available.
     */
    private deadLetterChangedDefinition(instance: WorkflowInstance, def: WorkflowDefinition, result: WorkflowExecutorResult): void {
        const message =
            `Workflow definition changed under a running instance: ` +
            `definitionId="${instance.workflowDefinitionId}", version=${instance.version}. ` +
            `The instance was started on definition fingerprint "${instance.definitionFingerprint}" but the ` +
            `registered definition now fingerprints as "${def.fingerprint}". Execution pointers reference steps ` +
            `by ordinal position, so resuming would execute a different step than the one this instance suspended ` +
            `at. This means the workflow was edited without a version bump (for YAML workflows, the catalog file ` +
            `at <nameSpace>/<name>/<version>/ was overwritten in place). To fix: publish the edit under a NEW ` +
            `version and leave the old version registered, so in-flight instances finish on the graph they started on.`;

        this.logger.log(LogLevel.Error, "Dead-lettering workflow — definition graph changed under a running instance", {
            workflowId: instance.id,
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version,
            startedFingerprint: instance.definitionFingerprint,
            registeredFingerprint: def.fingerprint,
            tenantId: instance.tenantId,
        });

        const perr = new ExecutionError();
        perr.message = message;
        perr.errorTime = new Date();
        result.errors.push(perr);

        const pointer = instance.executionPointers.find(p => p.active) || instance.executionPointers[0];
        let stepId = -1;
        if (pointer) {
            pointer.active = false;
            pointer.status = PointerStatus.DeadLettered;
            if (!pointer.endTime) pointer.endTime = new Date();
            if (!pointer.persistenceData) pointer.persistenceData = {};
            if (!Array.isArray(pointer.persistenceData._errors)) pointer.persistenceData._errors = [];
            pointer.persistenceData._errors.push({
                message,
                stack: null,
                errorTime: new Date().toISOString(),
                retryCount: pointer.retryCount || 0,
            });
            stepId = pointer.stepId;
        }

        instance.status = WorkflowStatus.DeadLettered;
        instance.nextExecution = null;

        const evt: WorkflowDeadLetteredEvent = {
            event: WORKFLOW_DEAD_LETTERED as "workflow.dead-lettered",
            workflowId: instance.id,
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version,
            pointerId: pointer ? pointer.id : "",
            stepId,
            retryCount: pointer ? (pointer.retryCount || 0) : 0,
            maxRetries: 0, // a changed definition is not retryable
            errorMessage: message,
            deadLetteredAt: new Date().toISOString(),
            reason: "definition-changed",
        };
        this.lifecycle.emit(evt);
    }

    /**
     * M1 — Dead-letter an instance whose (workflowDefinitionId, version) is not registered.
     *
     * Called when `tryGetDefinition` returns `undefined` at load time. This is NOT a
     * retryable condition (re-registering a definition is an operator action; retrying
     * would reproduce the original infinite-loop symptom). Dead-letters on the first
     * load that observes the miss, with `maxRetries: 0`.
     *
     * Reuses H5's `WorkflowStatus.DeadLettered`, `PointerStatus.DeadLettered`, and
     * the single `workflow.dead-lettered` lifecycle event. Does NOT redefine any of
     * those primitives.
     */
    private deadLetterMissingDefinition(instance: WorkflowInstance, result: WorkflowExecutorResult): void {
        const message =
            `Workflow definition not registered on load: ` +
            `definitionId="${instance.workflowDefinitionId}", version=${instance.version}. ` +
            `The host process has no registered definition for this (id, version) pair, so the instance ` +
            `cannot be executed. This usually means an old workflow version was not re-registered after a ` +
            `deploy. To fix: register all historical workflow versions on every host (never unregister old versions).`;

        this.logger.log(LogLevel.Error, "Dead-lettering workflow — definition not registered on load", {
            workflowId: instance.id,
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version,
            tenantId: instance.tenantId,
        });

        // Record the structured error on result.errors.
        const perr = new ExecutionError();
        perr.message = message;
        perr.errorTime = new Date();
        result.errors.push(perr);

        // Mark the genesis / first active pointer as the offending pointer.
        const pointer = instance.executionPointers.find(p => p.active) || instance.executionPointers[0];
        let stepId = -1;
        if (pointer) {
            pointer.active = false;
            pointer.status = PointerStatus.DeadLettered;
            if (!pointer.endTime) pointer.endTime = new Date();
            if (!pointer.persistenceData) pointer.persistenceData = {};
            if (!Array.isArray(pointer.persistenceData._errors)) pointer.persistenceData._errors = [];
            pointer.persistenceData._errors.push({
                message,
                stack: null,
                errorTime: new Date().toISOString(),
                retryCount: pointer.retryCount || 0,
            });
            stepId = pointer.stepId;
        }

        // Transition instance to terminal dead-letter state.
        instance.status = WorkflowStatus.DeadLettered;
        instance.nextExecution = null;

        // Emit exactly one lifecycle event reusing H5's payload shape.
        const evt: WorkflowDeadLetteredEvent = {
            event: WORKFLOW_DEAD_LETTERED as "workflow.dead-lettered",
            workflowId: instance.id,
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version,
            pointerId: pointer ? pointer.id : "",
            stepId,
            retryCount: pointer ? (pointer.retryCount || 0) : 0,
            maxRetries: 0, // missing-definition is not retryable (M1 spec §6.5)
            errorMessage: message,
            deadLetteredAt: new Date().toISOString(),
            reason: "definition-not-registered",
        };
        this.lifecycle.emit(evt);
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
            deadLetteredAt: new Date().toISOString(),
            reason: "step-not-found"
        };

        this.logger.log(LogLevel.Error, "Workflow dead-lettered", { workflowId: workflow.id, stepId: String(pointer.stepId), retryCount: pointer.retryCount, maxRetries, tenantId: workflow.tenantId });
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
        catch (err) { this.logger.log(LogLevel.Error, "Metrics call failed (ignored)", { err: toError(err) }); }
    }

    private safeSpan(fn: () => void): void {
        try { fn(); }
        catch (err) { this.logger.log(LogLevel.Error, "Tracer call failed (ignored)", { err: toError(err) }); }
    }

    private startSpanSafe(name: string, attributes: MetricAttributes): ISpan {
        try {
            return this.tracer.startSpan(name, attributes);
        }
        catch (err) {
            this.logger.log(LogLevel.Error, "Tracer.startSpan failed (ignored)", { err: toError(err) });
            return { setAttribute() {}, recordError() {}, end() {} };
        }
    }
}