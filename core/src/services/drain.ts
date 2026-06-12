/**
 * H4 — shared graceful-drain primitive for background workers.
 *
 * Awaits every promise currently in `inFlight`, but never longer than
 * `timeoutMs`. Resolves as soon as the last in-flight promise settles, or when
 * the timeout elapses, whichever comes first (spec H4 §6.2/§6.3). Rejections
 * are absorbed via Promise.allSettled so a failing execution can never cause
 * the drain to reject (spec H4 §6.12). With `timeoutMs <= 0` it resolves
 * essentially immediately without awaiting.
 *
 * The internal timeout timer is `.unref()`-ed so it never keeps the process
 * (or an Electron app quitting) alive (spec H4 §6.10).
 */
export function drainWithTimeout(inFlight: Iterable<Promise<void>>, timeoutMs: number): Promise<void> {
    const pending = Array.from(inFlight);
    if (pending.length === 0 || timeoutMs <= 0)
        return Promise.resolve();

    return Promise.race([
        Promise.allSettled(pending).then((): void => undefined),
        new Promise<void>((resolve) => {
            const timer: any = setTimeout(resolve, timeoutMs);
            if (timer && typeof timer.unref === "function")
                timer.unref();
        }),
    ]).then((): void => undefined);
}
