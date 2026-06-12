
export interface IBackgroundWorker {
    start(): void;
    /**
     * Stop intake immediately, then await all in-flight work for up to
     * `timeoutMs`. Resolves when drained or when the timeout elapses,
     * whichever comes first. MUST be idempotent: concurrent or repeated
     * calls share the same drain. A `timeoutMs` of 0 means "do not wait —
     * force stop immediately".
     * @param timeoutMs upper bound on the drain wait, in milliseconds.
     */
    stop(timeoutMs: number): Promise<void>;
    /**
     * H1: number of items this worker is currently executing (in-flight).
     * Backed by the same in-flight set H4's drain awaits. Workers without a
     * bounded pool (PollWorker) report their tick count (at most 1).
     */
    getActiveCount(): number;
    /**
     * H1: snapshot (copy) of the item IDs currently in flight — mutating the
     * returned array must not affect the worker. Workers whose in-flight work
     * has no item identity (PollWorker) return an empty array.
     */
    getActiveIds(): string[];
}
