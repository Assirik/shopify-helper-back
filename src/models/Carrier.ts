import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

const CarrierSchema = new Schema<ICarrier>(
  {
    name: { type: String, required: true, trim: true },
    phoneE164: { type: String, trim: true },
    // Prix indicatif (non figé) : le coût réel est saisi à la livraison car il dépend du
    // poids/volume/destination/fragilité. Sert de pré-remplissage uniquement.
    defaultPrice: { type: Number, min: 0 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  {
    timestamps: true
  }
);

CarrierSchema.set('toJSON', { virtuals: true });

export const Carrier = mongoose.model<ICarrier>('Carrier', CarrierSchema);

export interface ICarrier extends Document {
  _id: Types.ObjectId;
  name: string;
  phoneE164?: string;
  defaultPrice?: number;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
