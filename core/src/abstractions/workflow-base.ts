import { WorkflowBuilder } from "../fluent-builders";

export abstract class WorkflowBase<TData> {
    public abstract id: string;
    public abstract version: number;
    public abstract build(builder: WorkflowBuilder<TData>): void;

    /**
     * M10 — Optional content digest folded into this definition's fingerprint.
     *
     * The structural fingerprint hashes graph SHAPE only; step configuration lives in
     * input/output closures, which cannot be hashed dependably (see
     * `services/definition-fingerprint.ts`). A workflow generated from an external
     * source — a YAML catalog file, a database row — should set this to a digest of
     * that source, so editing the source without changing the shape still produces a
     * different fingerprint and still protects in-flight instances.
     *
     * Must be STABLE for identical source: derive it from the source text, never from a
     * timestamp, file mtime, or object identity, or every restart will invalidate every
     * running instance. Leave undefined for hand-written workflows, whose graph is
     * fixed at compile time.
     */
    public fingerprintSeed?: string;
}
