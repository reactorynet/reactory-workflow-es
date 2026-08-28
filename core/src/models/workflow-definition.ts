import { WorkflowStepBase } from "./workflow-step";

export class WorkflowDefinition {
    public id : string;
    public version: number;
    public description: string;
    public steps: Array<WorkflowStepBase> = [];
    public errorBehavior : number;
    public retryInterval : number;
    public maxRetries? : number;        // undefined => fall back to WorkflowOptions.retry.defaultMaxRetries

    /**
     * M10 — Stable hash of this definition's step graph, computed by
     * {@link computeDefinitionFingerprint} when the builder produces the definition.
     *
     * Stamped onto every WorkflowInstance at start and re-checked on every load, so an
     * instance can never resume against a graph that changed underneath it without a
     * version bump (execution pointers reference steps by ordinal index — see
     * `services/definition-fingerprint.ts`).
     *
     * Optional on the type for backward compatibility: a definition built by an older
     * `WorkflowBuilder.build(id, version)` call carries none, and the executor treats an
     * absent fingerprint on either side as "not enforceable" rather than a mismatch.
     */
    public fingerprint?: string;
}
