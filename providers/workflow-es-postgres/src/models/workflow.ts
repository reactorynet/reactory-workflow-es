import { Table, Column, Default, Model, HasMany, PrimaryKey, DataType, AllowNull, Index } from 'sequelize-typescript';
import { ExecutionPointer } from './executionPointer';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'workflows'
})
export class Workflow extends Model {

    @PrimaryKey
    @Default(DataType.UUIDV4)
    @Column(DataType.UUID)
    id: string;

    // M6 — tenant / namespace. NOT NULL DEFAULT 'default'; leads the composite
    // index (tenantId, status, nextExecution) used by getRunnableInstances.
    @AllowNull(false)
    @Default("default")
    @Index
    @Column(DataType.STRING)
    tenantId: string;

    @Column(DataType.STRING)
    workflowDefinitionId: string;

    @Column(DataType.INTEGER)
    version: number;

    @Column(DataType.STRING)
    description: string;

    // Epoch milliseconds (Date.now()) overflow a 4-byte INTEGER in Postgres, so
    // store as BIGINT. BIGINT is returned as a string by the pg driver, so the
    // accessor normalises it back to a JS number for the domain model.
    @Column(DataType.BIGINT)
    get nextExecution(): number {
        const value = (this as any).getDataValue('nextExecution');
        return value === null || value === undefined ? value : Number(value);
    }
    set nextExecution(value: number) {
        (this as any).setDataValue('nextExecution', value);
    }

    @Column(DataType.INTEGER)
    status: number;

    @Column(DataType.JSONB)
    data: any;

    @Column(DataType.DATE)
    createTime: Date;

    @Column(DataType.DATE)
    completeTime: Date;

    // Optimistic-concurrency token (spec C1). Default 0; rows written before this
    // column existed read as 0 via the default.
    @AllowNull(false)
    @Default(0)
    @Column(DataType.INTEGER)
    concurrencyToken: number;

    @HasMany(() => ExecutionPointer)
    executionPointers: ExecutionPointer[];
}
