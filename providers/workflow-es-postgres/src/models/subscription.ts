import { Table, Model, Column, Default, PrimaryKey, DataType, AllowNull, Index } from 'sequelize-typescript';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'subscriptions',
    indexes: [
        {
            // M2: backs getSubscriptions() — tenantId==t && eventName==n && eventKey==k && subscribeAsOf<=asOf.
            name: 'idx_subscriptions_name_key_subscribeasof',
            fields: ['tenantId', 'eventName', 'eventKey', 'subscribeAsOf']
        }
    ]
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
