import { Table, Model, Column, Default, PrimaryKey, DataType, AllowNull, Index } from 'sequelize-typescript';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'subscriptions'
})
export class Subscription extends Model {

    @PrimaryKey
    @Default(DataType.UUIDV4)
    @Column(DataType.UUID)
    id: string;

    // M6 — tenant / namespace; leads the (tenantId, eventName, eventKey) index.
    @AllowNull(false)
    @Default("default")
    @Index
    @Column(DataType.STRING)
    tenantId: string;

    // EventSubscription.workflowId is a plain string id in the core domain model.
    @Column(DataType.UUID)
    workflowId: string;

    @Column(DataType.INTEGER)
    stepId: number;

    @Column(DataType.STRING)
    eventName: string;

    @Column(DataType.JSONB)
    eventKey: any;

    @Column(DataType.DATE)
    subscribeAsOf: Date;
}
