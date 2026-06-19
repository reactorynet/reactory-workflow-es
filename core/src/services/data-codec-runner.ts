import { injectable, inject, optional } from "inversify";
import { TYPES, IDataCodec, DataCodecContext, WorkflowOptions } from "../abstractions";
import { WorkflowInstance, Event } from "../models";

/**
 * H6 — the single, provider-agnostic place the bound IDataCodec is invoked. Workers and the
 * host call the runner (encode before persist, decode after read), never the codec directly,
 * so every persistence provider benefits with zero per-provider crypto code.
 *
 * The optional size guard runs here, before encode, on the JSON byte length of the *plaintext*
 * payload (so the limit is meaningful regardless of ciphertext expansion). Its default value is
 * seeded from WorkflowOptions.dataCodecMaxBytes (0 = unlimited); it may also be overridden at
 * configuration time via WorkflowConfig.useDataCodecSizeLimit(bytes).
 */
@injectable()
export class DataCodecRunner {
    @inject(TYPES.IDataCodec)
    private codec: IDataCodec;

    // 0 / undefined = no limit. Seeded from WorkflowOptions.dataCodecMaxBytes in the
    // constructor; overridable via WorkflowConfig.useDataCodecSizeLimit(bytes).
    public maxPayloadBytes: number = 0;

    constructor(@inject(TYPES.WorkflowOptions) @optional() options?: WorkflowOptions) {
        if (options && typeof options.dataCodecMaxBytes === "number") {
            this.maxPayloadBytes = options.dataCodecMaxBytes;
        }
    }

    private guard(value: any, ctx: DataCodecContext): void {
        if (!this.maxPayloadBytes || value === undefined || value === null) return;
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
        if (bytes > this.maxPayloadBytes) {
            throw new Error(
                `workflow-es: ${ctx.kind} payload of ${bytes} bytes exceeds configured limit of ` +
                `${this.maxPayloadBytes} bytes`
            );
        }
    }

    public async encodeInstance(instance: WorkflowInstance): Promise<void> {
        if (!instance) return;
        const ctx: DataCodecContext = {
            kind: "instance.data",
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version
        };
        this.guard(instance.data, ctx);
        instance.data = await this.codec.encode(instance.data, ctx);
    }

    public async decodeInstance(instance: WorkflowInstance): Promise<void> {
        if (!instance) return;
        const ctx: DataCodecContext = {
            kind: "instance.data",
            workflowDefinitionId: instance.workflowDefinitionId,
            version: instance.version
        };
        instance.data = await this.codec.decode(instance.data, ctx);
    }

    public async encodeEvent(event: Event): Promise<void> {
        if (!event) return;
        const ctx: DataCodecContext = { kind: "event.data", eventName: event.eventName };
        this.guard(event.eventData, ctx);
        event.eventData = await this.codec.encode(event.eventData, ctx);
    }

    public async decodeEvent(event: Event): Promise<void> {
        if (!event) return;
        const ctx: DataCodecContext = { kind: "event.data", eventName: event.eventName };
        event.eventData = await this.codec.decode(event.eventData, ctx);
    }
}
