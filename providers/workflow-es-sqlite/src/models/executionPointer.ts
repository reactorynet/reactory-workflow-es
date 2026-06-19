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

    // Epoch milliseconds — same BIGINT normalisation as Workflow.nextExecution.
    @Column(DataType.BIGINT)
    get sleepUntil(): number {
        const value = (this as any).getDataValue('sleepUntil');
        return value === null || value === undefined ? value : Number(value);
    }
    set sleepUntil(value: number) {
        (this as any).setDataValue('sleepUntil', value);
    }

    // JSON columns: Sequelize serialises to TEXT on SQLite, equivalent to JSONB on Postgres.
    @Column(DataType.JSON)
    persistenceData: any;

    @Column(DataType.DATE)
    startTime: Date;

    @Column(DataType.DATE)
    endTime: Date;

    @Column(DataType.STRING)
    eventName: string;

    @Column(DataType.JSON)
    eventKey: any;

    @Column(DataType.BOOLEAN)
    eventPublished: boolean;

    @Column(DataType.JSON)
    eventData: any;

    @Column(DataType.JSON)
    outcome: any;

    @Column(DataType.STRING)
    stepName: string;

    @Default(0)
    @Column(DataType.INTEGER)
    retryCount: number;

    @Column(DataType.JSON)
    children: string[];

    @Column(DataType.JSON)
    contextItem: any;

    @Column(DataType.STRING)
    predecessorId: string;

    @Column(DataType.JSON)
    scope: string[];

    @Default(0)
    @Column(DataType.INTEGER)
    status: number;
}
