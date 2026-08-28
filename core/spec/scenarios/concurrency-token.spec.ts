import { WorkflowInstance, WorkflowStatus, WorkflowConcurrencyError } from "../../src";
import { MemoryPersistenceProvider } from "../../src/services/memory-persistence-provider";

// C1 — optimistic concurrency on IPersistenceProvider.persistWorkflow.
// These tests exercise the memory provider directly (no host), proving the
// compare-and-set / stale-write-rejection contract from the spec §5.2 / §6.
describe("concurrency token (memory provider)", () => {

    function newRunnableInstance(): WorkflowInstance {
        const wf = new WorkflowInstance();
        wf.workflowDefinitionId = "test-wf";
        wf.version = "1.0.0";
        wf.status = WorkflowStatus.Runnable;
        wf.nextExecution = 0;
        wf.data = { counter: 1 };
        return wf;
    }

    // Model a second node loading its own independent copy of the stored row.
    function clone(instance: WorkflowInstance): WorkflowInstance {
        return JSON.parse(JSON.stringify(instance)) as WorkflowInstance;
    }

    it("seeds token to 0 on createNewWorkflow", async () => {
        const p = new MemoryPersistenceProvider();
        const wf = newRunnableInstance();
        await p.createNewWorkflow(wf);

        expect(wf.concurrencyToken).toBe(0);
        const stored = await p.getWorkflowInstance(wf.id);
        expect(stored.concurrencyToken).toBe(0);
    });

    it("rejects a stale write with WorkflowConcurrencyError", async () => {
        const p = new MemoryPersistenceProvider();
        const wf = newRunnableInstance();
        await p.createNewWorkflow(wf);

        // Two independent copies, both at token 0.
        const a = clone(await p.getWorkflowInstance(wf.id));
        const b = clone(await p.getWorkflowInstance(wf.id));
        expect(a.concurrencyToken).toBe(0);
        expect(b.concurrencyToken).toBe(0);

        // First writer wins, token -> 1.
        await p.persistWorkflow(a);
        expect(a.concurrencyToken).toBe(1);

        // Second writer (still token 0) must be rejected.
        let caught: any = null;
        try {
            await p.persistWorkflow(b);
        }
        catch (err) {
            caught = err;
        }

        expect(caught).not.toBeNull();
        expect(caught instanceof WorkflowConcurrencyError).toBe(true);
        expect(caught.workflowId).toBe(wf.id);
        expect(caught.expectedToken).toBe(0);

        // Stored row is unchanged by the rejected write: still token 1, still A's data.
        const stored = await p.getWorkflowInstance(wf.id);
        expect(stored.concurrencyToken).toBe(1);
    });

    it("increments token on each successful persist", async () => {
        const p = new MemoryPersistenceProvider();
        const wf = newRunnableInstance();
        await p.createNewWorkflow(wf);

        await p.persistWorkflow(wf);
        await p.persistWorkflow(wf);
        await p.persistWorkflow(wf);

        expect(wf.concurrencyToken).toBe(3);
        const stored = await p.getWorkflowInstance(wf.id);
        expect(stored.concurrencyToken).toBe(3);
    });
});
