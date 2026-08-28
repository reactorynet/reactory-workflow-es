import { Table, Column, Default, Model, HasMany, PrimaryKey, DataType, AllowNull, Index } from 'sequelize-typescript';
import { ExecutionPointer } from './executionPointer';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'workflows',
    indexes: [
        {
            // M2: backs getRunnableInstances() — status===Runnable && nextExecution<now [&& tenantId==t].
            // tenantId leads (equality-before-range); when tenantId is omitted the planner uses
            // the status sub-index. Stable canonical name used by operational tooling.
            name: 'idx_workflows_status_next_execution',
            fields: ['tenantId', 'status', 'nextExecution']
        }
    ]
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

    // Epoch milliseconds (Date.now()). SQLite stores BIGINT as an 8-byte signed
    // integer; the driver may return it as a string, so normalise on read.
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

    // SQLite has no native JSONB; use DataType.JSON which Sequelize serialises to
    // a TEXT column and round-trips as a plain JS value — identical contract to JSONB.
    @Column(DataType.JSON)
    data: any;

    @Column(DataType.DATE)
    createTime: Date;

    @Column(DataType.DATE)
    completeTime: Date;

    // Optimistic-concurrency token (C1). Default 0; rows written before this
    // column existed read as 0 via the default.
    @AllowNull(false)
    @Default(0)
    @Column(DataType.INTEGER)
    concurrencyToken: number;

    // M10 — fingerprint of the definition graph the instance was STARTED on. Nullable
    // by design: rows written before M10 carry NULL and are exempt from the check, so
    // the column needs no backfill and no default.
    @Column(DataType.STRING)
    definitionFingerprint: string;

    @HasMany(() => ExecutionPointer)
    executionPointers: ExecutionPointer[];
}
