/** Normalises an unknown thrown value into an Error (strict-catch safe). */
export const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Thrown by IPersistenceProvider.persistWorkflow when the optimistic-concurrency
 * compare-and-set fails: the stored concurrencyToken did not match the expected token,
 * meaning another node persisted this instance first. The caller should discard its
 * in-memory instance, NOT retry the write blindly, and re-queue the workflow for a
 * fresh load-execute-persist cycle.
 */
export class WorkflowConcurrencyError extends Error {
    public readonly workflowId: string;
    public readonly expectedToken: number;
    constructor(workflowId: string, expectedToken: number) {
        super(`Optimistic concurrency conflict persisting workflow ${workflowId} ` +
              `(expected token ${expectedToken}); another node wrote first.`);
        this.name = "WorkflowConcurrencyError";
        this.workflowId = workflowId;
        this.expectedToken = expectedToken;
        // Restore prototype chain for instanceof under ES2020/commonjs target.
        Object.setPrototypeOf(this, WorkflowConcurrencyError.prototype);
    }
}
