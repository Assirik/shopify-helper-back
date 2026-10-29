import mongoose, { Document, Types } from 'mongoose';

const Schema = mongoose.Schema;

// Browser signals (Meta cookies, user agent, page URL) sent by the theme script when the
// customer types a phone number. One document per normalized phone: the latest capture
// replaces the previous one. Linked to the Shopify order by phone at ingestion.
export const BROWSER_SESSION_TTL_SECONDS = 60 * 60;

const BrowserSessionSchema = new Schema<IBrowserSession>(
  {
    phoneE164: { type: String, required: true, trim: true, unique: true },
    fbp: { type: String, trim: true },
    fbc: { type: String, trim: true },
    fbclid: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    pageUrl: { type: String, trim: true },
    ip: { type: String, trim: true }
  },
  {
    timestamps: true
  }
);

// Automatic deletion one hour after the last capture for this phone.
BrowserSessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: BROWSER_SESSION_TTL_SECONDS });

export const BrowserSession = mongoose.model<IBrowserSession>('BrowserSession', BrowserSessionSchema);

export interface IBrowserSession extends Document {
  _id: Types.ObjectId;
  phoneE164: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  userAgent?: string;
  pageUrl?: string;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}
