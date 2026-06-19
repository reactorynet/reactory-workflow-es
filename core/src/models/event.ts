export class Event {
    public id: string;
    /** M6 — tenant / namespace this event belongs to (default "default"). */
    public tenantId: string;
    public eventName: string;
    public eventKey: string;
    public eventData: any;
    public eventTime: Date;
    public isProcessed: boolean;
}