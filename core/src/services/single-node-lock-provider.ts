import { injectable } from "inversify";
import { IDistributedLockProvider } from "../abstractions";

@injectable()
export class SingleNodeLockProvider implements IDistributedLockProvider {
    private locks: string[] = [];

    public async acquireLock(id: string): Promise<boolean> {
        if (this.locks.includes(id))
            return false;
        this.locks.push(id);
        return true;
    }

    public async releaseLock(id: string): Promise<void> {
        const idx = this.locks.indexOf(id);
        if (idx > -1)
            this.locks.splice(idx, 1);
    }
}