import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum InboundWhatsAppEventStatus {
  PROCESSED = 'processed',
  IGNORED = 'ignored',
  NEEDS_ATTENTION = 'needs_attention',
  FAILED = 'failed'
}

const InboundWhatsAppEventSchema = new Schema<IInboundWhatsAppEvent>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', index: true },
    waMessageId: { type: String, trim: true, index: true },
    from: { type: String, trim: true, index: true },
    type: { type: String, trim: true, index: true },
    text: { type: String, trim: true },
    buttonPayload: { type: String, trim: true, index: true },
    buttonText: { type: String, trim: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    rawPayload: { type: Schema.Types.Mixed },
    processedStatus: {
      type: String,
      enum: Object.values(InboundWhatsAppEventStatus),
      default: InboundWhatsAppEventStatus.IGNORED,
      index: true
    }
  },
  {
    timestamps: true
  }
);

InboundWhatsAppEventSchema.index({ createdAt: -1 });
InboundWhatsAppEventSchema.index({ from: 1, createdAt: -1 });
InboundWhatsAppEventSchema.index({ orderId: 1, createdAt: -1 });

InboundWhatsAppEventSchema.set('toJSON', {
  virtuals: true
});

export const InboundWhatsAppEvent = mongoose.model<IInboundWhatsAppEvent>('InboundWhatsAppEvent', InboundWhatsAppEventSchema);

export interface IInboundWhatsAppEvent extends Document {
  _id: Types.ObjectId;
  messageId?: Types.ObjectId;
  waMessageId?: string;
  from?: string;
  type?: string;
  text?: string;
  buttonPayload?: string;
  buttonText?: string;
  orderId?: Types.ObjectId;
  rawPayload?: unknown;
  processedStatus: InboundWhatsAppEventStatus;
  createdAt: Date;
  updatedAt: Date;
}
