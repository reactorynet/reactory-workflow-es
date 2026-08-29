import { injectable } from "inversify";
import { WorkflowDefinition } from "../models";
import { WorkflowBase, IWorkflowRegistry } from "../abstractions";
import { WorkflowBuilder } from "../fluent-builders";

@injectable()
export class WorkflowRegistry implements IWorkflowRegistry {
    private registry: RegistryEntry[] = [];

    public getDefinition(id: string, version: string): WorkflowDefinition {
        const def = this.tryGetDefinition(id, version);
        if (!def)
            // Render id and version as separate labelled fields rather than `${id}@${version}`.
            // Consumers conventionally embed the version in the id itself
            // ("ns.Name@1.0.0"), so the concatenated form produced a confusing
            // "ns.Name@9.9.9@9.9.9" and hid which half of the key actually missed.
            throw new Error(`Workflow not registered: id="${id}" version="${version}"`);
        return def;
    }

    /**
     * M1 — Non-throwing variant: returns the definition or `undefined` on a miss.
     * Used by the executor at load time so a missing (id, version) pair can be
     * dead-lettered cleanly instead of propagating an exception.
     */
    public tryGetDefinition(id: string, version: string): WorkflowDefinition | undefined {
        const item = this.registry.find(x => x.id === id && x.version === version);
        return item ? item.defintion : undefined;
    }

    public registerWorkflow<TData>(workflow: WorkflowBase<TData>): void {
        const entry = new RegistryEntry();
        entry.id = workflow.id;
        entry.version = workflow.version;
        const builder = new WorkflowBuilder<TData>();
        workflow.build(builder);
        // M10 — the seed (when the workflow supplies one) is folded into the definition
        // fingerprint so a content-only edit to a generated workflow is still detected.
        entry.defintion = builder.build(workflow.id, workflow.version, workflow.fingerprintSeed);
        this.registry.push(entry);
    }
}

class RegistryEntry {
    public id: string;
    public version: string;
    public defintion: WorkflowDefinition;
}