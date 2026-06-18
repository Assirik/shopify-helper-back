import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export enum MessageChannel {
  WHATSAPP = 'whatsapp',
  SMS = 'sms'
}

export enum MessageProvider {
  META = 'meta',
  TERMII = 'termii'
}

export enum MessageStatus {
  QUEUED = 'queued',
  SENDING = 'sending',
  SENT = 'sent',
  FAILED = 'failed'
}

const MessageAttemptSchema = new Schema<IMessageAttempt>(
  {
    attemptNumber: { type: Number, min: 1 },
    status: { type: String, enum: [MessageStatus.SENT, MessageStatus.FAILED], required: true },
    providerMessageId: { type: String, trim: true },
    providerResponse: { type: Schema.Types.Mixed },
    errorCode: { type: String, trim: true },
    errorMessage: { type: String, trim: true },
    at: { type: Date, default: Date.now }
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    channel: { type: String, enum: Object.values(MessageChannel), required: true, index: true },
    provider: { type: String, enum: Object.values(MessageProvider), required: true, index: true },
    status: { type: String, enum: Object.values(MessageStatus), default: MessageStatus.QUEUED, index: true },
    templateName: { type: String, trim: true },
    templateLanguage: { type: String, trim: true },
    buttonPayload: { type: String, trim: true, index: true },
    attemptCount: { type: Number, default: 0, min: 0 },
    providerMessageId: { type: String, trim: true, index: true },
    providerResponse: { type: Schema.Types.Mixed },
    errorCode: { type: String, trim: true },
    errorMessage: { type: String, trim: true },
    attempts: { type: [MessageAttemptSchema], default: [] },
    fallbackOfMessageId: { type: Schema.Types.ObjectId, ref: 'Message', index: true }
  },
  {
    timestamps: true
  }
);

MessageSchema.index({ createdAt: -1 });
MessageSchema.index({ status: 1, createdAt: -1 });
MessageSchema.index({ channel: 1, provider: 1, status: 1 });
MessageSchema.index({ orderId: 1, createdAt: -1 });

MessageSchema.set('toJSON', {
  virtuals: true
});

export const Message = mongoose.model<IMessage>('Message', MessageSchema);

export interface IMessageAttempt {
  attemptNumber?: number;
  status: MessageStatus.SENT | MessageStatus.FAILED;
  providerMessageId?: string;
  providerResponse?: unknown;
  errorCode?: string;
  errorMessage?: string;
  at: Date;
}

export interface IMessage extends Document {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  channel: MessageChannel;
  provider: MessageProvider;
  status: MessageStatus;
  templateName?: string;
  templateLanguage?: string;
  buttonPayload?: string;
  attemptCount: number;
  providerMessageId?: string;
  providerResponse?: unknown;
  errorCode?: string;
  errorMessage?: string;
  attempts: IMessageAttempt[];
  fallbackOfMessageId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
