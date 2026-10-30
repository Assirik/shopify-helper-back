import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  PARTIALLY_SENT = 'partially_sent'
}

export enum CapiPurchaseStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  SKIPPED = 'skipped'
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
  ADMIN = 'admin',
  PHONE_CALL = 'phone_call'
}

export enum ReminderSource {
  ADMIN = 'admin',
  AUTO = 'auto'
}

export enum OrderOperationalStatus {
  TO_DELIVER = 'to_deliver',
  IN_DELIVERY = 'in_delivery',
  DELIVERED = 'delivered',
  DELIVERY_FAILED = 'delivery_failed',
  RETURNED = 'returned'
}

export enum DeliveryChannel {
  INTERNAL = 'internal',
  CARRIER = 'carrier'
}

export enum CodPaymentStatus {
  PAID = 'paid',
  PARTIAL = 'partial',
  UNPAID = 'unpaid'
}

export enum AttentionReasonCode {
  FREE_TEXT = 'free_text',
  SMS_ONLY = 'sms_only',
  INVALID_NUMBER = 'invalid_number',
  LATE_CONFIRM = 'late_confirm',
  UNREACHABLE = 'unreachable',
  PHONE_MISMATCH = 'phone_mismatch',
  NOTIFICATION_NOT_SCHEDULED = 'notification_not_scheduled'
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
    fbclid: { type: String, trim: true },
    adId: { type: String, trim: true },
    campaignId: { type: String, trim: true },
    adsetId: { type: String, trim: true },
    utmSource: { type: String, trim: true },
    utmMedium: { type: String, trim: true },
    capiFbp: { type: String, trim: true },
    capiFbc: { type: String, trim: true },
    capiClientUserAgent: { type: String, trim: true },
    capiEventSourceUrl: { type: String, trim: true },
    capiValueEur: { type: Number },
    capiFxRate: { type: Number },
    capiPurchaseStatus: { type: String, enum: Object.values(CapiPurchaseStatus) },
    capiPurchaseSentAt: { type: Date },
    capiEventId: { type: String, trim: true },
    capiPurchaseError: { type: String, trim: true },
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
    needsHelpdeskAttention: { type: Boolean, default: false, index: true },
    operationalStatus: { type: String, enum: Object.values(OrderOperationalStatus), index: true },
    deliveryChannel: { type: String, enum: Object.values(DeliveryChannel) },
    assignedCourierId: { type: Schema.Types.ObjectId, ref: 'Courier', index: true },
    assignedCarrierId: { type: Schema.Types.ObjectId, ref: 'Carrier', index: true },
    carrierTrackingNumber: { type: String, trim: true },
    dispatchedAt: { type: Date },
    deliveredAt: { type: Date },
    deliveryAttempts: { type: Number, default: 0, min: 0 },
    deliveryFailureReason: { type: String, trim: true },
    returnReason: { type: String, trim: true },
    codExpectedAmount: { type: Number },
    codCollectedAmount: { type: Number },
    courierFeeAmount: { type: Number },
    carrierFeeAmount: { type: Number },
    codNetRemitted: { type: Number },
    codPaymentStatus: { type: String, enum: Object.values(CodPaymentStatus) },
    collectedAt: { type: Date },
    lastNoteText: { type: String, trim: true },
    lastNoteAt: { type: Date }
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
OrderSchema.index({ operationalStatus: 1, createdAt: -1 });
OrderSchema.index({ assignedCourierId: 1, deliveredAt: 1 });
OrderSchema.index({ assignedCarrierId: 1, deliveredAt: 1 });
OrderSchema.index({ deliveredAt: 1 });
OrderSchema.index({ capiPurchaseStatus: 1, confirmedAt: 1 });
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
  fbclid?: string;
  adId?: string;
  campaignId?: string;
  adsetId?: string;
  utmSource?: string;
  utmMedium?: string;
  capiFbp?: string;
  capiFbc?: string;
  capiClientUserAgent?: string;
  capiEventSourceUrl?: string;
  capiValueEur?: number;
  capiFxRate?: number;
  capiPurchaseStatus?: CapiPurchaseStatus;
  capiPurchaseSentAt?: Date;
  capiEventId?: string;
  capiPurchaseError?: string;
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
  operationalStatus?: OrderOperationalStatus;
  deliveryChannel?: DeliveryChannel;
  assignedCourierId?: Types.ObjectId;
  assignedCarrierId?: Types.ObjectId;
  carrierTrackingNumber?: string;
  dispatchedAt?: Date;
  deliveredAt?: Date;
  deliveryAttempts: number;
  deliveryFailureReason?: string;
  returnReason?: string;
  codExpectedAmount?: number;
  codCollectedAmount?: number;
  courierFeeAmount?: number;
  carrierFeeAmount?: number;
  codNetRemitted?: number;
  codPaymentStatus?: CodPaymentStatus;
  collectedAt?: Date;
  lastNoteText?: string;
  lastNoteAt?: Date;
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
