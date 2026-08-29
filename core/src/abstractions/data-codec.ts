/**
 * Identifies which opaque payload is being transformed and the workflow it belongs to.
 * Passed to encode/decode so a codec MAY key/scope ciphertext (e.g. per workflow definition)
 * without the codec needing access to the whole instance. Purely advisory: a codec may ignore it.
 */
export interface DataCodecContext {
    /** "instance.data" | "event.data" — the logical slot being transformed. */
    kind: "instance.data" | "event.data";
    /** Workflow definition id, when known (instance.data path). Optional. */
    workflowDefinitionId?: string;
    /** Workflow definition version, when known. Optional. */
    version?: string;
    /** Event name, when known (event.data path). Optional. NEVER itself encoded. */
    eventName?: string;
}

/**
 * At-rest transform for the engine's two opaque payloads (H6):
 *   - WorkflowInstance.data
 *   - Event.eventData
 *
 * `encode` is applied in core immediately before the value is handed to the persistence provider.
 * `decode` is applied in core immediately after the value is read back from the provider, before it
 * is exposed to step bodies / callers.
 *
 * Contract:
 *  - decode(encode(x)) must deep-equal x for any JSON-serialisable x (round-trip).
 *  - encode/decode MUST be idempotent at the boundary: encode is applied once per persist, decode
 *    once per read; the DataCodecRunner guarantees single application.
 *  - The returned value MUST be storable in the existing data/eventData slot (JSON-compatible:
 *    object | array | string | number | boolean | null). An encrypting codec therefore returns an
 *    envelope object, e.g. { __wfes_enc: 1, alg: "...", ct: "<base64>" }, NOT a raw Buffer.
 *  - encode/decode MUST NOT touch or depend on any other field (eventName/eventKey/status remain
 *    plaintext and queryable).
 */
export interface IDataCodec {
    encode(value: any, context: DataCodecContext): Promise<any>;
    decode(value: any, context: DataCodecContext): Promise<any>;
}
