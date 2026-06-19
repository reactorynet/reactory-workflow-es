import { Table, Column, Model, Default, PrimaryKey, DataType, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Workflow } from './workflow';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'execution_pointers'
})
export class ExecutionPointer extends Model {

    @PrimaryKey
    @Default(DataType.UUIDV4)
    @Column(DataType.UUID)
    id: string;

    @ForeignKey(() => Workflow)
    @Column(DataType.UUID)
    workflowId: string;

    @BelongsTo(() => Workflow)
    workflow: Workflow;

    @Column(DataType.INTEGER)
    stepId: number;

    @Column(DataType.BOOLEAN)
    active: boolean;

    // Epoch milliseconds — see Workflow.nextExecution for the BIGINT rationale.
    @Column(DataType.BIGINT)
    get sleepUntil(): number {
        const value = (this as any).getDataValue('sleepUntil');
        return value === null || value === undefined ? value : Number(value);
    }
    set sleepUntil(value: number) {
        (this as any).setDataValue('sleepUntil', value);
    }

    @Column(DataType.JSONB)
    persistenceData: any;

    @Column(DataType.DATE)
    startTime: Date;

    @Column(DataType.DATE)
    endTime: Date;

    @Column(DataType.STRING)
    eventName: string;

    @Column(DataType.JSONB)
    eventKey: any;

    @Column(DataType.BOOLEAN)
    eventPublished: boolean;

    @Column(DataType.JSONB)
    eventData: any;

    @Column(DataType.JSONB)
    outcome: any;

    @Column(DataType.STRING)
    stepName: string;

    @Default(0)
    @Column(DataType.INTEGER)
    retryCount: number;

    @Column(DataType.JSONB)
    children: string[];

    @Column(DataType.JSONB)
    contextItem: any;

    @Column(DataType.STRING)
    predecessorId: string;

    @Column(DataType.JSONB)
    scope: string[];

    @Default(0)
    @Column(DataType.INTEGER)
    status: number;
}
