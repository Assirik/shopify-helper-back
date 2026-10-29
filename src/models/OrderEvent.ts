import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum OrderEventType {
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  REMINDED = 'reminded',
  DISPATCHED = 'dispatched',
  DELIVERED = 'delivered',
  DELIVERY_FAILED = 'delivery_failed',
  RETURNED = 'returned',
  PAYMENT_RECORDED = 'payment_recorded',
  NOTE = 'note',
  CAPI_PURCHASE_SENT = 'capi_purchase_sent',
  CAPI_PURCHASE_FAILED = 'capi_purchase_failed',
  CAPI_PURCHASE_SKIPPED = 'capi_purchase_skipped',
  PHONE_MISMATCH = 'phone_mismatch'
}

const OrderEventSchema = new Schema<IOrderEvent>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    type: { type: String, enum: Object.values(OrderEventType), required: true },
    fromStatus: { type: String, trim: true },
    toStatus: { type: String, trim: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true },
    metadata: { type: Schema.Types.Mixed }
  },
  {
    timestamps: true
  }
);

OrderEventSchema.index({ orderId: 1, createdAt: -1 });
OrderEventSchema.set('toJSON', { virtuals: true });

export const OrderEvent = mongoose.model<IOrderEvent>('OrderEvent', OrderEventSchema);

export interface IOrderEvent extends Document {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  type: OrderEventType;
  fromStatus?: string;
  toStatus?: string;
  actorId?: Types.ObjectId;
  note?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
