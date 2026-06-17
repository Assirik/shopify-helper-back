import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  PARTIALLY_SENT = 'partially_sent'
}

const OrderSchema = new Schema<IOrder>(
  {
    shopifyOrderId: { type: String, required: true, trim: true, unique: true },
    shopifyOrderName: { type: String, required: true, trim: true, index: true },
    customerName: { type: String, trim: true },
    customerPhoneRaw: { type: String, trim: true },
    customerPhoneE164: { type: String, trim: true, index: true },
    customerEmail: { type: String, trim: true, lowercase: true },
    totalPrice: { type: String, required: true, trim: true },
    currency: { type: String, required: true, trim: true, uppercase: true },
    financialStatus: { type: String, trim: true },
    fulfillmentStatus: { type: String, trim: true },
    notificationStatus: {
      type: String,
      enum: Object.values(NotificationStatus),
      default: NotificationStatus.PENDING,
      index: true
    }
  },
  {
    timestamps: true
  }
);

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ notificationStatus: 1, createdAt: -1 });
OrderSchema.index({ shopifyOrderName: 'text', customerPhoneE164: 'text', customerPhoneRaw: 'text' });

OrderSchema.set('toJSON', {
  virtuals: true
});

export const Order = mongoose.model<IOrder>('Order', OrderSchema);

export interface IOrder extends Document {
  _id: Types.ObjectId;
  shopifyOrderId: string;
  shopifyOrderName: string;
  customerName?: string;
  customerPhoneRaw?: string;
  customerPhoneE164?: string;
  customerEmail?: string;
  totalPrice: string;
  currency: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  notificationStatus: NotificationStatus;
  createdAt: Date;
  updatedAt: Date;
}
