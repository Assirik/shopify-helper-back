import mongoose, { Document } from 'mongoose';
/* import CryptoJS from 'crypto-js'; */
import bcrypt from 'bcrypt';
const Schema = mongoose.Schema;
export enum Role {
  ADMIN = 'ADMIN',
  USER = 'USER',
  IOT = 'IOT',
  DEVELOPER = 'DEVELOPER',
  DEVICE = 'DEVICE'
}

const UserSchema = new Schema<IUser>(
  {
    userName: { type: String, trim: true, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    phone: { type: String, trim: true, index: { unique: true, sparse: true } },
    role: { type: String, enum: Object.values(Role), default: Role.USER },
    fcmTokens: { type: [String], default: [] } // Tokens Firebase Cloud Messaging pour les notifications push
  },
  {
    timestamps: true
  }
);

UserSchema.set('toJSON', {
  virtuals: true
});

UserSchema.methods.setPassword = async function (plainPssswd: string) {
  this.password = await bcrypt.hash(plainPssswd, 10);
};

/* UserSchema.methods.setPassword = function setPassword(pwd: string) {
  const salt = CryptoJS.lib.WordArray.random(128 / 8);
  this.password = {
    salt: salt.toString(),
    hash: CryptoJS.SHA256(pwd + salt).toString()
  };
}; */

UserSchema.methods.isPasswordValid = async function (plainPasswd: string) {
  try {
    const valid = await bcrypt.compare(plainPasswd, this.password);
    return valid;
  } catch {
    return false;
  }
};

export const User = mongoose.model<IUser>('User', UserSchema);

export interface IUser extends Document {
  userName: string;
  email: string;
  password: string;
  phone?: string;
  role: Role;
  fcmTokens: string[]; // Array of FCM tokens for push notifications
  setPassword(plainPssswd: string): Promise<void>;
  isPasswordValid(plainPasswd: string): Promise<boolean>;
}
