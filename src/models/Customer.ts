import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

const CustomerSchema = new Schema<ICustomer>(
  {
    shopifyCustomerId: { type: String, trim: true, unique: true, sparse: true },
    shopifyCustomerGraphqlId: { type: String, trim: true },
    fullName: { type: String, trim: true, index: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phoneRaw: { type: String, trim: true },
    phoneE164: { type: String, trim: true, index: { unique: true, sparse: true } },
    email: { type: String, trim: true, lowercase: true, index: true },
    address1: { type: String, trim: true },
    address2: { type: String, trim: true },
    city: { type: String, trim: true, index: true },
    region: { type: String, trim: true, index: true },
    country: { type: String, trim: true },
    countryCode: { type: String, trim: true, uppercase: true },
    orderCount: { type: Number, default: 0, min: 0 },
    lastOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    lastOrderName: { type: String, trim: true },
    lastOrderAt: { type: Date }
  },
  {
    timestamps: true
  }
);

CustomerSchema.index({ createdAt: -1 });
CustomerSchema.index({ updatedAt: -1 });
CustomerSchema.index({ fullName: 'text', phoneE164: 'text', phoneRaw: 'text', email: 'text' });

CustomerSchema.set('toJSON', {
  virtuals: true
});

export const Customer = mongoose.model<ICustomer>('Customer', CustomerSchema);

export interface ICustomer extends Document {
  _id: Types.ObjectId;
  shopifyCustomerId?: string;
  shopifyCustomerGraphqlId?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  phoneRaw?: string;
  phoneE164?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  orderCount: number;
  lastOrderId?: Types.ObjectId;
  lastOrderName?: string;
  lastOrderAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
