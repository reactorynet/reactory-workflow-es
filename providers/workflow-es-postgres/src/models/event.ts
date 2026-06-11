import { Table, Model, Column, Default, PrimaryKey, DataType } from 'sequelize-typescript';

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
