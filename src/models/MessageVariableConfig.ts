import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

// Single global document (one shop / one tenant for now).
export const MESSAGE_VARIABLE_CONFIG_KEY = 'global';

// Two region-based variants for a free-text template variable.
const RegionVariantSchema = new Schema<IRegionVariant>(
  {
    dakar: { type: String, trim: true },
    nonDakar: { type: String, trim: true }
  },
  { _id: false }
);

const MessageVariableConfigSchema = new Schema<IMessageVariableConfig>(
  {
    key: { type: String, default: MESSAGE_VARIABLE_CONFIG_KEY, unique: true },
    shippingNote: { type: RegionVariantSchema, default: () => ({}) },
    paymentMethod: { type: RegionVariantSchema, default: () => ({}) },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  {
    timestamps: true
  }
);

MessageVariableConfigSchema.set('toJSON', { virtuals: true });

export const MessageVariableConfig = mongoose.model<IMessageVariableConfig>(
  'MessageVariableConfig',
  MessageVariableConfigSchema
);

export interface IRegionVariant {
  dakar?: string;
  nonDakar?: string;
}

export interface IMessageVariableConfig extends Document {
  key: string;
  shippingNote: IRegionVariant;
  paymentMethod: IRegionVariant;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
