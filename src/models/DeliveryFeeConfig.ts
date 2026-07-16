import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

export const DELIVERY_FEE_CONFIG_KEY = 'global';

const RegionFeeSchema = new Schema<IRegionDeliveryFee>(
  {
    regionCode: { type: String, required: true, trim: true, uppercase: true },
    amount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const DeliveryFeeConfigSchema = new Schema<IDeliveryFeeConfig>(
  {
    key: { type: String, default: DELIVERY_FEE_CONFIG_KEY, unique: true },
    defaultFee: { type: Number, required: true, min: 0, default: 0 },
    regionFees: { type: [RegionFeeSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  {
    timestamps: true
  }
);

DeliveryFeeConfigSchema.set('toJSON', { virtuals: true });

export const DeliveryFeeConfig = mongoose.model<IDeliveryFeeConfig>('DeliveryFeeConfig', DeliveryFeeConfigSchema);

export interface IRegionDeliveryFee {
  regionCode: string;
  amount: number;
}

/** Auteur peuplé de la dernière modification (`populate('updatedBy', 'userName')`). */
export interface IUpdatedByUser {
  _id: Types.ObjectId;
  userName: string;
}

export interface IDeliveryFeeConfig extends Document {
  key: string;
  defaultFee: number;
  regionFees: IRegionDeliveryFee[];
  updatedBy?: Types.ObjectId | IUpdatedByUser | null;
  createdAt: Date;
  updatedAt: Date;
}
