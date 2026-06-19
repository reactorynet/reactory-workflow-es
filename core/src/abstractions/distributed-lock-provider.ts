import { DEFAULT_TENANT } from "./types";

export interface IDistributedLockProvider {
    acquireLock(id: string): Promise<boolean>;
    releaseLock(id: string): Promise<void>;
}

/**
 * M6 — build a tenant-namespaced lock key from a tenant id and a bare resource
 * id. The key is OPAQUE to the lock provider (IDistributedLockProvider does NOT
 * change): callers pass the result to acquireLock/releaseLock and providers must
 * not parse it. A falsy tenant coerces to DEFAULT_TENANT so the key shape is
 * uniform across the codebase. The matching release MUST use the identical key.
 */
export function tenantLockKey(tenantId: string, id: string): string {
    return `${tenantId || DEFAULT_TENANT}:${id}`;
}