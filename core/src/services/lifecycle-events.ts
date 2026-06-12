import { injectable } from "inversify";
import { ILifecycleEventHub, LifecycleEvent } from "../abstractions";

/**
 * H5 — default in-process lifecycle event hub.
 *
 * No-op until a handler is registered. Emission is synchronous and
 * best-effort: a throwing handler must never break the engine or affect
 * persistence (spec h5 §6.12).
 */
@injectable()
export class LifecycleEventHub implements ILifecycleEventHub {
    private handlers: Array<(evt: LifecycleEvent) => void> = [];

    public on(handler: (evt: LifecycleEvent) => void): void {
        this.handlers.push(handler);
    }

    public emit(evt: LifecycleEvent): void {
        // synchronous, best-effort; a throwing handler must not break the engine
        for (const handler of this.handlers) {
            try {
                handler(evt);
            }
            catch {
                /* swallow: handlers must not affect engine state */
            }
        }
    }
}
