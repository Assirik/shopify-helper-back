import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  PARTIALLY_SENT = 'partially_sent'
}

export enum CustomerConfirmationStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  NEEDS_ATTENTION = 'needs_attention',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  SMS_ONLY = 'sms_only'
}

export enum ConfirmationSource {
  WHATSAPP_BUTTON = 'whatsapp_button',
  ADMIN = 'admin'
}

export enum ReminderSource {
  ADMIN = 'admin',
  AUTO = 'auto'
}

export enum AttentionReasonCode {
  FREE_TEXT = 'free_text',
  SMS_ONLY = 'sms_only',
  INVALID_NUMBER = 'invalid_number',
  LATE_CONFIRM = 'late_confirm'
}

const OrderLineItemSchema = new Schema<IOrderLineItem>(
  {
    shopifyLineItemId: { type: String, trim: true },
    productId: { type: String, trim: true, index: true },
    variantId: { type: String, trim: true },
    title: { type: String, trim: true },
    name: { type: String, trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    price: { type: String, trim: true },
    sku: { type: String, trim: true },
    vendor: { type: String, trim: true },
    productExists: { type: Boolean },
    variantInventoryManagement: { type: String, trim: true },
    variantTitle: { type: String, trim: true },
    fulfillmentStatus: { type: String, trim: true }
  },
  { _id: false }
);

const OrderSchema = new Schema<IOrder>(
  {
    shopifyOrderId: { type: String, required: true, trim: true, unique: true },
    shopifyOrderName: { type: String, required: true, trim: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', index: true },
    customerName: { type: String, trim: true },
    customerPhoneRaw: { type: String, trim: true },
    customerPhoneE164: { type: String, trim: true, index: true },
    customerEmail: { type: String, trim: true, lowercase: true },
    lineItems: { type: [OrderLineItemSchema], default: [] },
    totalPrice: { type: String, required: true, trim: true },
    subtotalPrice: { type: String, trim: true },
    currentTotalPrice: { type: String, trim: true },
    totalOutstanding: { type: String, trim: true },
    totalDiscounts: { type: String, trim: true },
    shippingPrice: { type: String, trim: true },
    shippingTitle: { type: String, trim: true },
    shippingRegion: { type: String, trim: true, index: true },
    deliveryRegion: { type: String, trim: true },
    deliveryRegionCode: { type: String, trim: true, index: true },
    deliveryPreferredMoment: { type: String, trim: true },
    deliveryAddress: { type: String, trim: true },
    deliveryLatitude: { type: Number },
    deliveryLongitude: { type: Number },
    browserIp: { type: String, trim: true },
    customerLocale: { type: String, trim: true },
    currency: { type: String, required: true, trim: true, uppercase: true },
    paymentGatewayNames: { type: [String], default: [] },
    isCashOnDelivery: { type: Boolean, default: false, index: true },
    tags: { type: [String], default: [] },
    sourceName: { type: String, trim: true, index: true },
    orderStatusUrl: { type: String, trim: true },
    noteAttributes: { type: Schema.Types.Mixed },
    isTest: { type: Boolean, default: false, index: true },
    shopifyCancelledAt: { type: Date },
    shopifyCancelReason: { type: String, trim: true },
    financialStatus: { type: String, trim: true },
    fulfillmentStatus: { type: String, trim: true },
    notificationStatus: {
      type: String,
      enum: Object.values(NotificationStatus),
      default: NotificationStatus.PENDING,
      index: true
    },
    customerConfirmationStatus: {
      type: String,
      enum: Object.values(CustomerConfirmationStatus),
      default: CustomerConfirmationStatus.PENDING,
      index: true
    },
    confirmationSource: { type: String, enum: Object.values(ConfirmationSource) },
    confirmedAt: { type: Date },
    confirmationCancelledAt: { type: Date },
    expiredAt: { type: Date },
    confirmationCancelReason: { type: String, trim: true },
    lastCustomerMessageAt: { type: Date },
    lastCustomerMessageText: { type: String, trim: true },
    reminderCount: { type: Number, default: 0, min: 0 },
    lastReminderAt: { type: Date },
    lastReminderSource: { type: String, enum: Object.values(ReminderSource) },
    confirmationPayload: { type: Schema.Types.Mixed },
    attentionReason: { type: String, trim: true },
    attentionReasonCode: { type: String, enum: Object.values(AttentionReasonCode), index: true },
    attentionRequiredAt: { type: Date, index: true },
    needsHelpdeskAttention: { type: Boolean, default: false, index: true }
  },
  {
    timestamps: true
  }
);

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ notificationStatus: 1, createdAt: -1 });
OrderSchema.index({ customerConfirmationStatus: 1, createdAt: -1 });
OrderSchema.index({ isCashOnDelivery: 1, createdAt: -1 });
OrderSchema.index({ needsHelpdeskAttention: 1, attentionReasonCode: 1, attentionRequiredAt: -1 });
OrderSchema.index({ shopifyOrderName: 'text', customerPhoneE164: 'text', customerPhoneRaw: 'text' });

OrderSchema.set('toJSON', {
  virtuals: true
});

export const Order = mongoose.model<IOrder>('Order', OrderSchema);

export interface IOrder extends Document {
  _id: Types.ObjectId;
  shopifyOrderId: string;
  shopifyOrderName: string;
  customerId?: Types.ObjectId;
  customerName?: string;
  customerPhoneRaw?: string;
  customerPhoneE164?: string;
  customerEmail?: string;
  lineItems: IOrderLineItem[];
  totalPrice: string;
  subtotalPrice?: string;
  currentTotalPrice?: string;
  totalOutstanding?: string;
  totalDiscounts?: string;
  shippingPrice?: string;
  shippingTitle?: string;
  shippingRegion?: string;
  deliveryRegion?: string;
  deliveryRegionCode?: string;
  deliveryPreferredMoment?: string;
  deliveryAddress?: string;
  deliveryLatitude?: number;
  deliveryLongitude?: number;
  browserIp?: string;
  customerLocale?: string;
  currency: string;
  paymentGatewayNames: string[];
  isCashOnDelivery: boolean;
  tags: string[];
  sourceName?: string;
  orderStatusUrl?: string;
  noteAttributes?: Record<string, string>;
  isTest: boolean;
  shopifyCancelledAt?: Date;
  shopifyCancelReason?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  notificationStatus: NotificationStatus;
  customerConfirmationStatus: CustomerConfirmationStatus;
  confirmationSource?: ConfirmationSource;
  confirmedAt?: Date;
  confirmationCancelledAt?: Date;
  expiredAt?: Date;
  confirmationCancelReason?: string;
  lastCustomerMessageAt?: Date;
  lastCustomerMessageText?: string;
  reminderCount: number;
  lastReminderAt?: Date;
  lastReminderSource?: ReminderSource;
  confirmationPayload?: unknown;
  attentionReason?: string;
  attentionReasonCode?: AttentionReasonCode;
  attentionRequiredAt?: Date;
  needsHelpdeskAttention: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IOrderLineItem {
  shopifyLineItemId?: string;
  productId?: string;
  variantId?: string;
  title?: string;
  name?: string;
  quantity: number;
  price?: string;
  sku?: string;
  vendor?: string;
  productExists?: boolean;
  variantInventoryManagement?: string;
  variantTitle?: string;
  fulfillmentStatus?: string;
}
