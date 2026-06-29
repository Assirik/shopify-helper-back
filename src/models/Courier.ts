import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

const CourierSchema = new Schema<ICourier>(
  {
    name: { type: String, required: true, trim: true },
    phoneE164: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  {
    timestamps: true
  }
);

CourierSchema.set('toJSON', { virtuals: true });

export const Courier = mongoose.model<ICourier>('Courier', CourierSchema);

export interface ICourier extends Document {
  _id: Types.ObjectId;
  name: string;
  phoneE164?: string;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
