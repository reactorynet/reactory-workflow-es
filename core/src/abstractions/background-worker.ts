
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
}
