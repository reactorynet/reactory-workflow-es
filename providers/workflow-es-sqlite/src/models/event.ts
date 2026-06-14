import { Table, Model, Column, Default, PrimaryKey, DataType, AllowNull, Index } from 'sequelize-typescript';

@Table({
    timestamps: false,
    freezeTableName: true,
    tableName: 'events'
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

    @Column(DataType.JSON)
    eventData: any;

    @Column(DataType.DATE)
    eventTime: Date;

    @Column(DataType.BOOLEAN)
    isProcessed: boolean;
}
