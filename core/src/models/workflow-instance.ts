import { ExecutionPointer } from "./execution-pointer";

export class WorkflowInstance {

    public id : string;
    /**
     * M6 — tenant / namespace this instance belongs to. Defaults to "default"
     * (DEFAULT_TENANT) when the host caller omits a tenantId. Stamped by the
     * host in startWorkflow; copied onto every EventSubscription the instance
     * creates so subscription matching stays tenant-scoped.
     */
    public tenantId : string;
    public workflowDefinitionId : string;
    /** M11 — semantic version of the definition this instance runs. Immutable once set. */
    public version : string;
    public description : string;
    public nextExecution : number;
    public status : number;
    public data : any;
    public createTime : Date;
    public completeTime : Date;
    public executionPointers : Array<ExecutionPointer> = [];

    /**
     * Optimistic-concurrency token. Monotonically increasing integer, owned by the
     * persistence provider. `createNewWorkflow` seeds it to 0. Every successful
     * `persistWorkflow` MUST (a) only succeed if the stored token equals the token on
     * the instance being written (compare-and-set), and (b) increment the stored token
     * by 1 and write that new value back onto the in-memory `instance.concurrencyToken`
     * so the caller can persist again in the same execution without re-loading.
     * Undefined/absent is treated as 0 for backward compatibility with rows written
     * before this field existed.
     */
    public concurrencyToken?: number = 0;

    /**
     * M10 — Fingerprint of the definition graph this instance was STARTED on, copied
     * from `WorkflowDefinition.fingerprint` by the host in startWorkflow and never
     * mutated afterwards.
     *
     * On every load the executor compares it against the currently registered
     * definition's fingerprint. A mismatch means the graph was edited without a version
     * bump, so the ordinal `stepId` on this instance's pointers no longer refers to the
     * step it was suspended at; the instance is dead-lettered instead of executed.
     *
     * Optional and nullable BY DESIGN: rows written before this field existed carry no
     * fingerprint, and those instances must keep running. An absent value on either the
     * instance or the definition disables the check for that instance — it is never
     * treated as a mismatch. See `services/definition-fingerprint.ts`.
     */
    public definitionFingerprint?: string;

    constructor() {

    }
}