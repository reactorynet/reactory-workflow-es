import { injectable } from "inversify";
import { WorkflowDefinition } from "../models";
import { WorkflowBase, IWorkflowRegistry } from "../abstractions";
import { WorkflowBuilder } from "../fluent-builders";

@injectable()
export class WorkflowRegistry implements IWorkflowRegistry {
    private registry: RegistryEntry[] = [];

    public getDefinition(id: string, version: number): WorkflowDefinition {
        const item = this.registry.find(x => x.id === id && x.version === version);
        if (!item)
            throw new Error(`Workflow not registered: ${id}@${version}`);
        return item.defintion;
    }

    public registerWorkflow<TData>(workflow: WorkflowBase<TData>): void {
        const entry = new RegistryEntry();
        entry.id = workflow.id;
        entry.version = workflow.version;
        const builder = new WorkflowBuilder<TData>();
        workflow.build(builder);
        entry.defintion = builder.build(workflow.id, workflow.version);
        this.registry.push(entry);
    }
}

class RegistryEntry {
    public id: string;
    public version: number;
    public defintion: WorkflowDefinition;
}