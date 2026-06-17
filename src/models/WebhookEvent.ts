import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum WebhookEventStatus {
  RECEIVED = 'received',
  PROCESSED = 'processed',
  DUPLICATE = 'duplicate',
  FAILED = 'failed'
}

const WebhookEventSchema = new Schema<IWebhookEvent>(
  {
    webhookId: { type: String, trim: true, unique: true, sparse: true },
    topic: { type: String, required: true, trim: true, index: true },
    shopDomain: { type: String, trim: true, index: true },
    payloadHash: { type: String, required: true, trim: true, index: true },
    status: {
      type: String,
      enum: Object.values(WebhookEventStatus),
      default: WebhookEventStatus.RECEIVED,
      index: true
    },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    errorMessage: { type: String, trim: true }
  },
  {
    timestamps: true
  }
);

WebhookEventSchema.index({ createdAt: -1 });
WebhookEventSchema.index({ topic: 1, shopDomain: 1, createdAt: -1 });
WebhookEventSchema.index({ payloadHash: 1, topic: 1, shopDomain: 1 });

WebhookEventSchema.set('toJSON', {
  virtuals: true
});

export const WebhookEvent = mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);

export interface IWebhookEvent extends Document {
  _id: Types.ObjectId;
  webhookId?: string;
  topic: string;
  shopDomain?: string;
  payloadHash: string;
  status: WebhookEventStatus;
  orderId?: Types.ObjectId;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}
