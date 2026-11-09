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

    // A plain string key, matching EventModel.eventKey. This was JSONB, which
    // made every insert fail with "invalid input syntax for type json" and
    // broke getSubscriptions() — the provider queries it by string equality.
    @Column(DataType.STRING)
    eventKey: string;

    @Column(DataType.DATE)
    subscribeAsOf: Date;
}
