/**
 * H5 — minimal in-process lifecycle event hub.
 *
 * Deliberately tiny: a synchronous, error-swallowing handler list so the engine
 * can surface terminal conditions (currently only `workflow.dead-lettered`) to
 * hosts and tests. This is NOT the M5 metrics/tracing surface; M5/M4 may layer a
 * richer bus on the consumer side, and M1 reuses the `workflow.dead-lettered`
 * event verbatim.
 */

export const WORKFLOW_DEAD_LETTERED = "workflow.dead-lettered";

export interface WorkflowDeadLetteredEvent {
    event: "workflow.dead-lettered";
    workflowId: string;
    workflowDefinitionId: string;
    version: number;
    pointerId: string;
    stepId: number;
    retryCount: number;          // failed attempts processed by the error strategy when the budget was declared exhausted
    maxRetries: number;          // the resolved budget that was exhausted
    errorMessage: string | null; // last error message, from pointer.persistenceData._errors (null if none recorded)
    deadLetteredAt: string;      // ISO8601
}

export type LifecycleEvent = WorkflowDeadLetteredEvent;

export interface ILifecycleEventHub {
    on(handler: (evt: LifecycleEvent) => void): void;
    emit(evt: LifecycleEvent): void;
}
