import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

const ProductVariantSchema = new Schema<IProductVariant>(
  {
    shopifyVariantId: { type: String, trim: true },
    title: { type: String, trim: true },
    sku: { type: String, trim: true, index: true },
    lastKnownPrice: { type: String, trim: true },
    inventoryManagement: { type: String, trim: true },
    lastSeenAt: { type: Date }
  },
  { _id: false }
);

const ProductSchema = new Schema<IProduct>(
  {
    shopifyProductId: { type: String, trim: true, unique: true, sparse: true },
    title: { type: String, trim: true, required: true },
    vendor: { type: String, trim: true, index: true },
    productExists: { type: Boolean, default: true },
    variants: { type: [ProductVariantSchema], default: [] },
    lastOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    lastOrderName: { type: String, trim: true },
    lastSeenAt: { type: Date },
    totalOrderedQuantity: { type: Number, default: 0, min: 0 },
    stockTrackingEnabled: { type: Boolean, default: false },
    stockQuantity: { type: Number, min: 0 },
    lowStockThreshold: { type: Number, min: 0 }
  },
  {
    timestamps: true
  }
);

ProductSchema.index({ createdAt: -1 });
ProductSchema.index({ updatedAt: -1 });
ProductSchema.index({ title: 'text', vendor: 'text', 'variants.sku': 'text' });

ProductSchema.set('toJSON', {
  virtuals: true
});

export const Product = mongoose.model<IProduct>('Product', ProductSchema);

export interface IProduct extends Document {
  _id: Types.ObjectId;
  shopifyProductId?: string;
  title: string;
  vendor?: string;
  productExists: boolean;
  variants: IProductVariant[];
  lastOrderId?: Types.ObjectId;
  lastOrderName?: string;
  lastSeenAt?: Date;
  totalOrderedQuantity: number;
  stockTrackingEnabled: boolean;
  stockQuantity?: number;
  lowStockThreshold?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IProductVariant {
  shopifyVariantId?: string;
  title?: string;
  sku?: string;
  lastKnownPrice?: string;
  inventoryManagement?: string;
  lastSeenAt?: Date;
}
