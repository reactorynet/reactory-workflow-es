
export interface IDistributedLockProvider {
    acquireLock(id: string): Promise<boolean>;
    releaseLock(id: string): Promise<void>;
}