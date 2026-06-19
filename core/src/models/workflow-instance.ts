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
    public version : number;
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

    constructor() {

    }
}