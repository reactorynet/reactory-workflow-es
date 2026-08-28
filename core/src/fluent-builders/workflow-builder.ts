import { StepBody, InlineStepBody } from "../abstractions";
import { WorkflowDefinition, WorkflowStepBase, WorkflowStep, StepOutcome, StepExecutionContext, ExecutionResult, WorkflowErrorHandling } from "../models";
import { WaitFor, Foreach, While, If, Delay, Schedule } from "../primitives";
import { StepBuilder } from "./step-builder";
// Direct file import (not the ../services barrel) — the barrel pulls in workflow-host,
// which imports the fluent builders, and that would close an import cycle.
import { computeDefinitionFingerprint } from "../services/definition-fingerprint";

export class WorkflowBuilder<TData> {
    
    private steps: Array<WorkflowStepBase> = [];
    public errorBehavior : number = WorkflowErrorHandling.Retry;
    public retryInterval : number = (60 * 1000);
    public maxRetries? : number;        // undefined => WorkflowOptions.retry.defaultMaxRetries

    /**
     * @param fingerprintSeed M10 — optional content digest folded into the definition
     *        fingerprint, for definitions generated from an external source. See
     *        `WorkflowBase.fingerprintSeed`.
     */
    public build(id: string, version: number, fingerprintSeed?: string): WorkflowDefinition {
        var result = new WorkflowDefinition();
        result.id = id;
        result.version = version;
        result.steps = this.steps;
        result.errorBehavior = this.errorBehavior;
        result.retryInterval = this.retryInterval;
        result.maxRetries = this.maxRetries;
        // M10 — computed once, after the graph is complete, so the hash covers the
        // final wiring rather than a partially built chain.
        result.fingerprint = computeDefinitionFingerprint(this.steps, fingerprintSeed);

        return result;
    }

    public addStep(step: WorkflowStepBase) {
        step.id = this.steps.length;
        this.steps.push(step);
    }

    public startWith<TNewStepBody extends StepBody>(body: { new(): TNewStepBody; }, setup: (step: StepBuilder<TNewStepBody, TData>) => void = null): StepBuilder<TNewStepBody, TData> {
        let step = new WorkflowStep<TNewStepBody>();
        step.body = body;
        let stepBuilder = new StepBuilder<TNewStepBody, TData>(this, step);

        //setup
        if (setup) {
            setup(stepBuilder);
        }
        
        this.addStep(step);
        return stepBuilder;
    }

    public getUpstreamSteps(id: number): Array<WorkflowStepBase> {
        return this.steps.filter(step => step.outcomes.filter(outcome => outcome.nextStep == id).length > 0);
    }

    public lastStep(): number {
        let last = this.steps.reduce((prev, current) => prev.id > current.id ? prev : current);
        return last.id;
    }
}