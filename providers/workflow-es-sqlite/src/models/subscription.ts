import { Table, Model, Column, Default, PrimaryKey, DataType } from 'sequelize-typescript';

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

    // EventSubscription.workflowId is a plain string id in the core domain model.
    @Column(DataType.UUID)
    workflowId: string;

    @Column(DataType.INTEGER)
    stepId: number;

    @Column(DataType.STRING)
    eventName: string;

    // JSON: event keys can be any type in the domain model.
    @Column(DataType.JSON)
    eventKey: any;

    @Column(DataType.DATE)
    subscribeAsOf: Date;
}
