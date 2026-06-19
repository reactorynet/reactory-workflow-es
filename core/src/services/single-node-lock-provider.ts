import { injectable } from "inversify";
import { IDistributedLockProvider } from "../abstractions";

const SINGLE_NODE_DEV_ONLY_MESSAGE =
    "SingleNodeLockProvider/SingleNodeQueueProvider are dev-only and cannot be shared by " +
    "multiple workflow hosts. Use a distributed provider (e.g. @reactorynet/workflow-es-redis) " +
    "or call configureWorkflow().allowSingleNodeProviders(true) to override.";

@injectable()
export class SingleNodeLockProvider implements IDistributedLockProvider {
    private locks: string[] = [];
    private started: boolean = false;

    /**
     * Dev-only fail-loud guard. The first WorkflowHost.start() on this singleton marks it
     * started. A second host starting on the same singleton instance (the realistic
     * in-process multi-host case) throws unless single-node providers were explicitly
     * allowed. See spec C1 §6.9.
     */
    public markStarted(allowSingleNodeProviders: boolean): void {
        if (this.started && !allowSingleNodeProviders) {
            throw new Error(SINGLE_NODE_DEV_ONLY_MESSAGE);
        }
        this.started = true;
    }

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