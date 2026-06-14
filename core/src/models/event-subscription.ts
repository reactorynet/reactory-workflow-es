export class EventSubscription {
    public id: string;
    /** M6 — tenant / namespace, copied from the owning instance's tenantId. */
    public tenantId: string;
    public workflowId: string;
    public stepId: number;
    public eventName: string;
    public eventKey: any;
    public subscribeAsOf: Date;
}