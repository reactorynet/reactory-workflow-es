import { Table, Model, Column, Default, PrimaryKey, DataType, AllowNull, Index } from 'sequelize-typescript';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'events',
    indexes: [
        {
            // M2: backs getRunnableEvents() — !isProcessed && eventTime<=now [&& tenantId==t].
            name: 'idx_events_isprocessed_eventtime',
            fields: ['tenantId', 'isProcessed', 'eventTime']
        },
        {
            // M2: backs getEvents() — tenantId==t && eventName==n && eventKey==k && eventTime>=asOf.
            name: 'idx_events_name_key_eventtime',
            fields: ['tenantId', 'eventName', 'eventKey', 'eventTime']
        }
    ]
})
export class Event extends Model {

    @PrimaryKey
    @Default(DataType.UUIDV4)
    @Column(DataType.UUID)
    id: string;

    // M6 — tenant / namespace; leads the (tenantId, eventName, eventKey, eventTime) index.
    @AllowNull(false)
    @Default("default")
    @Index
    @Column(DataType.STRING)
    tenantId: string;

    @Column(DataType.STRING)
    eventName: string;

    @Column(DataType.STRING)
    eventKey: string;

    @Column(DataType.JSONB)
    eventData: any;

    @Column(DataType.DATE)
    eventTime: Date;

    @Column(DataType.BOOLEAN)
    isProcessed: boolean;
}
