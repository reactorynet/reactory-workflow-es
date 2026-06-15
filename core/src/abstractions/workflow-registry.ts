import { WorkflowDefinition } from "../models";
import { WorkflowBase } from "./workflow-base";

export interface IWorkflowRegistry {
    /** Returns the definition or THROWS if not registered. Use at start time (fail fast). */
    getDefinition(id: string, version: number) : WorkflowDefinition;
    /**
     * M1 — Returns the definition or `undefined` if not registered. Never throws.
     * Use at load time (in the executor) so a missing version can be dead-lettered
     * cleanly instead of propagating a generic exception.
     */
    tryGetDefinition(id: string, version: number) : WorkflowDefinition | undefined;
    registerWorkflow<TData>(workflow: WorkflowBase<TData>): void;
}