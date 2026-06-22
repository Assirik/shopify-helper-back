import mongoose, { Document } from 'mongoose';
/* import CryptoJS from 'crypto-js'; */
import bcrypt from 'bcrypt';
const Schema = mongoose.Schema;
export enum Role {
  ADMIN = 'ADMIN',
  USER = 'USER',
  DEVELOPER = 'DEVELOPER'
}

const UserSchema = new Schema<IUser>(
  {
    userName: { type: String, trim: true, required: true, unique: true },
    email: { type: String, trim: true, lowercase: true, required: true, unique: true },
    password: { type: String, required: true, select: false },
    phone: { type: String, trim: true, index: { unique: true, sparse: true } },
    role: { type: String, enum: Object.values(Role), default: Role.USER },
    isActive: { type: Boolean, default: true, index: true },
    disabledAt: { type: Date },
    sessionVersion: { type: Number, default: 0, select: false },
    bootstrapKey: { type: String, unique: true, sparse: true, select: false },
    fcmTokens: { type: [String], default: [] }
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
  isActive: boolean;
  disabledAt?: Date;
  sessionVersion: number;
  bootstrapKey?: string;
  fcmTokens: string[];
  setPassword(plainPssswd: string): Promise<void>;
  isPasswordValid(plainPasswd: string): Promise<boolean>;
}
