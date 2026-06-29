import { configureWorkflow, WorkflowHost, WorkflowBuilder, WorkflowStatus, WorkflowBase, StepBody, StepExecutionContext, ExecutionResult, WorkflowInstance, ConsoleLogger, ExecutionPointer, PointerStatus, StepOutcome, WorkflowStep, WorkflowExecutorResult } from "../../src";
import { ExecutionResultProcessor } from "../../src/services/execution-result-processor";
import { NullLogger } from "../../src/services/null-logger";
import { inspect } from "util";

// A step that reverts its children after compensation (like SagaContainer). Used to prove
// that shouldCompensate INVOKES revertChildrenAfterCompensation() rather than reading the
// (always-truthy) method reference (P0.1).
class RevertingStep extends WorkflowStep<any> {
    public revertChildrenAfterCompensation(): boolean { return true; }
    public resumeChildrenAfterCompensation(): boolean { return false; }
}

 describe("ExecutionResultProcessor", () => {
       
    let subject: any = new ExecutionResultProcessor();
    subject.logger = new NullLogger();
    
    beforeEach(() => {
        subject.pointerFactory = { buildNextPointer: function() {} }
    });    

    it("should advance workflow", function() {
        //arrange
        let pointer1 = new ExecutionPointer();
        pointer1.active = true;
        pointer1.stepId = 0;
        pointer1.status = PointerStatus.Running;
        let pointer2 = new ExecutionPointer();        
        let outcome = new StepOutcome();
        outcome.nextStep = 1;
        let step = new WorkflowStep();
        step.outcomes.push(outcome);
        let instance = givenWorkflow([pointer1]);        
        let wfResult = new WorkflowExecutorResult();
        let stepResult = new ExecutionResult();
        stepResult.proceed = true;
        stepResult.outcomeValue = null;
        spyOn(subject.pointerFactory, "buildNextPointer").and.returnValue(pointer2);

        //act
        subject.processExecutionResult(stepResult, pointer1, instance, step, wfResult);

        //assert
        expect(pointer1.active).toBe(false);
        expect(pointer1.status).toBe(PointerStatus.Complete);
        expect(pointer1.endTime).toBeDefined();
        expect(instance.executionPointers).toContain(pointer2);
        expect(subject.pointerFactory.buildNextPointer).toHaveBeenCalled();
    });

    it("should set persistence data", function() {
        //arrange
        let data = new Object();
        let pointer = new ExecutionPointer();
        pointer.active = true;
        pointer.stepId = 0;
        pointer.status = PointerStatus.Running;
        let step = new WorkflowStep();
        let instance = givenWorkflow([pointer]);
        let wfResult = new WorkflowExecutorResult();
        let stepResult = new ExecutionResult();
        stepResult.proceed = false;
        stepResult.persistenceData = data;
        
        //act
        subject.processExecutionResult(stepResult, pointer, instance, step, wfResult);

        //assert
        expect(pointer.persistenceData).toBe(data);
    });

    it("should subscribe to event", function() {
        //arrange
        let pointer = new ExecutionPointer();
        pointer.active = true;
        pointer.stepId = 0;
        pointer.status = PointerStatus.Running;
        let step = new WorkflowStep();
        let instance = givenWorkflow([pointer]);
        let wfResult = new WorkflowExecutorResult();
        let stepResult = new ExecutionResult();
        stepResult.proceed = false;
        stepResult.eventKey = "key";
        stepResult.eventName = "event";
                
        //act
        subject.processExecutionResult(stepResult, pointer, instance, step, wfResult);

        //assert
        expect(pointer.active).toBe(false);
        expect(pointer.status).toBe(PointerStatus.WaitingForEvent);
        expect(pointer.eventName).toBe(stepResult.eventName);
        expect(pointer.eventKey).toBe(stepResult.eventKey);
        expect(wfResult.subscriptions.length).toBe(1);
    });

    // ---- P0.4: outcome matching must use strict equality (===), not loose (==) ----

    it("P0.4: outcome value 0 does NOT match outcomeValue false (strict equality)", function() {
        let pointer = new ExecutionPointer();
        pointer.active = true;
        pointer.stepId = 0;
        pointer.status = PointerStatus.Running;
        let outcome = new StepOutcome();
        outcome.value = () => 0;            // numeric outcome
        outcome.nextStep = 1;
        let step = new WorkflowStep();
        step.outcomes.push(outcome);
        let instance = givenWorkflow([pointer]);
        let wfResult = new WorkflowExecutorResult();
        let stepResult = new ExecutionResult();
        stepResult.proceed = true;
        stepResult.outcomeValue = false;   // 0 == false under loose equality, but 0 !== false
        spyOn(subject.pointerFactory, "buildNextPointer").and.returnValue(new ExecutionPointer());

        subject.processExecutionResult(stepResult, pointer, instance, step, wfResult);

        // Under the old `==` this matched (0 == false) and built a pointer; strict `===` must not.
        expect(subject.pointerFactory.buildNextPointer).not.toHaveBeenCalled();
    });

    it("P0.4: outcome value 0 matches outcomeValue 0 (strict equality)", function() {
        let pointer = new ExecutionPointer();
        pointer.active = true;
        pointer.stepId = 0;
        pointer.status = PointerStatus.Running;
        let outcome = new StepOutcome();
        outcome.value = () => 0;
        outcome.nextStep = 1;
        let step = new WorkflowStep();
        step.outcomes.push(outcome);
        let instance = givenWorkflow([pointer]);
        let wfResult = new WorkflowExecutorResult();
        let stepResult = new ExecutionResult();
        stepResult.proceed = true;
        stepResult.outcomeValue = 0;
        let next = new ExecutionPointer();
        spyOn(subject.pointerFactory, "buildNextPointer").and.returnValue(next);

        subject.processExecutionResult(stepResult, pointer, instance, step, wfResult);

        expect(subject.pointerFactory.buildNextPointer).toHaveBeenCalled();
        expect(instance.executionPointers).toContain(next);
    });

    // ---- P0.1: shouldCompensate must INVOKE revertChildrenAfterCompensation(), not read the ref ----

    it("P0.1: shouldCompensate returns false for a plain step with no compensation", function() {
        let pointer = new ExecutionPointer();
        pointer.id = "p";
        pointer.stepId = 0;
        let step = new WorkflowStep();     // base: revertChildrenAfterCompensation() === false; no compensationStepId
        step.id = 0;
        let workflow = givenWorkflow([pointer]);
        let definition: any = { steps: [step] };

        // Old bug: `if (step.revertChildrenAfterCompensation)` read a truthy method ref → always true.
        expect(subject.shouldCompensate(workflow, definition, pointer)).toBe(false);
    });

    it("P0.1: shouldCompensate returns true when an in-scope step reverts children (saga)", function() {
        let pointer = new ExecutionPointer();
        pointer.id = "p";
        pointer.stepId = 0;
        let step = new RevertingStep();    // revertChildrenAfterCompensation() === true
        step.id = 0;
        let workflow = givenWorkflow([pointer]);
        let definition: any = { steps: [step] };

        expect(subject.shouldCompensate(workflow, definition, pointer)).toBe(true);
    });

    it("P0.1: shouldCompensate returns true when the step has a compensationStepId", function() {
        let pointer = new ExecutionPointer();
        pointer.id = "p";
        pointer.stepId = 0;
        let step = new WorkflowStep();
        step.id = 0;
        step.compensationStepId = 5;
        let workflow = givenWorkflow([pointer]);
        let definition: any = { steps: [step] };

        expect(subject.shouldCompensate(workflow, definition, pointer)).toBe(true);
    });

    // ---- P0.5: sibling scope comparison must be order-independent (set equality) ----

    it("P0.5: revert compensates a completed sibling whose scope is a reordering", function() {
        let saga = new RevertingStep(); saga.id = 0;
        let mid = new WorkflowStep(); mid.id = 1;
        let failed = new WorkflowStep(); failed.id = 2;                 // no compensationStepId
        let sibling = new WorkflowStep(); sibling.id = 3; sibling.compensationStepId = 7;
        let definition: any = { steps: [saga, mid, failed, sibling] };

        let sagaP = new ExecutionPointer(); sagaP.id = "s"; sagaP.stepId = 0; sagaP.scope = [];
        let midP  = new ExecutionPointer(); midP.id  = "m"; midP.stepId  = 1; midP.scope  = ["s"];
        let failP = new ExecutionPointer(); failP.id = "f"; failP.stepId = 2; failP.scope = ["s", "m"];
        let sibP  = new ExecutionPointer(); sibP.id  = "b"; sibP.stepId  = 3;
        sibP.scope = ["m", "s"];                  // SAME set as failP.scope, REVERSED order
        sibP.status = PointerStatus.Complete;

        let workflow = givenWorkflow([sagaP, midP, failP, sibP]);

        subject.pointerFactory.buildCompensationPointer =
            jasmine.createSpy("buildCompensationPointer").and.returnValue(new ExecutionPointer());

        //act — compensate the failed pointer (a parent saga sets revert=true)
        subject.compensate(workflow, definition, failP);

        //assert — the reordered-scope sibling was found and compensated. Under the old
        // JSON.stringify comparison (["s","m"] vs ["m","s"]) it would NOT have matched.
        expect(subject.pointerFactory.buildCompensationPointer).toHaveBeenCalled();
        expect(sibP.status).toBe(PointerStatus.Compensated);
    });

});


function givenWorkflow(pointers: ExecutionPointer[]): WorkflowInstance {
    let result = new WorkflowInstance();
    result.status = WorkflowStatus.Runnable;
    result.executionPointers.push(...pointers);
    return result;
}