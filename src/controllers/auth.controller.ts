import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { IUser, Role, User } from '../models/User';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';
import { isValidEmail, isValidPassword, isValidUserName } from '../utilities/validation/userCredentials';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type ValidationDetails = Record<string, string>;

export const isValidSignupPassword = isValidPassword;

export const buildLoginLookup = (identifier: string) => {
  const trimmed = identifier.trim();

  return trimmed.includes('@')
    ? { $or: [{ userName: trimmed }, { email: trimmed.toLowerCase() }] }
    : { userName: trimmed };
};

const toSafeUser = (user: IUser) => {
  const result = user.toObject() as Record<string, unknown>;
  delete result.password;
  delete result.sessionVersion;
  delete result.bootstrapKey;
  result.isActive = user.isActive !== false;
  return result;
};

const toPositiveInteger = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getUserId = (req: Request) => (typeof req.params.userId === 'string' ? req.params.userId : '');

const isDuplicateKeyError = (error: unknown) => {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
};

const getDuplicateKeyFields = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('keyPattern' in error)) return [];
  const keyPattern = error.keyPattern;
  return typeof keyPattern === 'object' && keyPattern !== null ? Object.keys(keyPattern) : [];
};

const validateIdentity = (body: unknown, partial = false) => {
  const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const details: ValidationDetails = {};
  const allowedFields = partial ? ['userName', 'email', 'phone', 'role'] : ['userName', 'email', 'phone', 'role', 'password'];
  const unknownFields = Object.keys(input).filter(field => !allowedFields.includes(field));

  if (unknownFields.length) {
    details.body = `Unsupported fields: ${unknownFields.join(', ')}`;
  }

  if ((!partial || 'userName' in input) && !isValidUserName(input.userName)) {
    details.userName = 'Must contain 3 to 50 letters, numbers, dots, underscores or hyphens';
  }

  if ((!partial || 'email' in input) && !isValidEmail(input.email)) {
    details.email = 'Must be a valid email address';
  }

  if ('phone' in input && input.phone !== null && input.phone !== undefined) {
    const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    if (!phone || phone.length > 30) {
      details.phone = 'Must contain between 1 and 30 characters';
    }
  }

  if ('role' in input && !Object.values(Role).includes(input.role as Role)) {
    details.role = 'Must be a supported role';
  }

  return { input, details };
};

const respondWithPersistenceError = (res: Response, error: unknown, context: Record<string, unknown>) => {
  if (isDuplicateKeyError(error)) {
    return res.status(409).json({ error: 'UserAlreadyExists' });
  }

  log.error({ err: error, ...context }, 'User administration failed');
  return res.status(500).json({ error: 'InternalError' });
};

export class AuthController {
  public static async bootstrapAdmin(req: Request, res: Response) {
    const { input, details } = validateIdentity(req.body);
    if ('role' in input) details.role = 'Role is forced to ADMIN and must not be provided';
    if (!isValidSignupPassword(input.password)) details.password = 'Must contain 8 to 72 bytes';
    if (Object.keys(details).length) return res.status(400).json({ error: 'ValidationFailed', details });

    const existingAdmin = await User.exists({ role: Role.ADMIN });
    if (existingAdmin) return res.status(409).json({ error: 'BootstrapAlreadyCompleted' });

    try {
      const admin = new User({
        userName: (input.userName as string).trim(),
        email: (input.email as string).trim().toLowerCase(),
        phone: typeof input.phone === 'string' ? input.phone.trim() : undefined,
        role: Role.ADMIN,
        isActive: true,
        bootstrapKey: 'initial-admin'
      });
      await admin.setPassword(input.password as string);
      await admin.save();

      log.info({ createdUserId: admin._id, userName: admin.userName }, 'Initial administrator created through bootstrap endpoint');
      return res.status(201).json({ data: toSafeUser(admin) });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const code = getDuplicateKeyFields(error).includes('bootstrapKey')
          ? 'BootstrapAlreadyCompleted'
          : 'UserAlreadyExists';
        return res.status(409).json({ error: code });
      }

      log.error({ err: error }, 'Initial administrator bootstrap failed');
      return res.status(500).json({ error: 'InternalError' });
    }
  }

  public static async login(req: Request, res: Response) {
    const identifier =
      typeof req.body?.identifier === 'string'
        ? req.body.identifier.trim()
        : typeof req.body?.userName === 'string'
          ? req.body.userName.trim()
          : typeof req.body?.email === 'string'
            ? req.body.email.trim()
            : '';

    try {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const user = identifier
        ? await User.findOne(buildLoginLookup(identifier)).select('+password +sessionVersion')
        : null;

      if (!user || !password || !(await user.isPasswordValid(password))) {
        return res.status(401).json({ error: 'InvalidCredentials' });
      }

      if (user.isActive === false) {
        return res.status(403).json({ error: 'AccountDisabled' });
      }

      const sessionVersion = user.sessionVersion ?? 0;

      return res.status(200).json({
        userId: user._id,
        token: jwt.sign({ userId: user._id.toString(), sessionVersion }, config.jwtSecret, { expiresIn: '365d' }),
        user: toSafeUser(user),
        message: 'Successful'
      });
    } catch (error) {
      log.error({ err: error, identifierType: identifier.includes('@') ? 'email' : 'userName' }, 'Login failed');
      return res.status(500).json({ error: 'InternalError' });
    }
  }

  public static async me(req: Request, res: Response) {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'UserNotFound' });
    }

    return res.status(200).json({ user: toSafeUser(user) });
  }

  public static async changeOwnPassword(req: Request, res: Response) {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = req.body?.newPassword;

    if (!currentPassword || !isValidSignupPassword(newPassword)) {
      return res.status(400).json({ error: 'InvalidPassword' });
    }

    const user = await User.findById(req.userId).select('+password +sessionVersion');

    if (!user) {
      return res.status(404).json({ error: 'UserNotFound' });
    }

    if (!(await user.isPasswordValid(currentPassword))) {
      return res.status(401).json({ error: 'BadPassword' });
    }

    await user.setPassword(newPassword);
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    await user.save();

    log.info({ userId: user._id }, 'User changed own password');
    return res.status(200).json({ message: 'PasswordChanged' });
  }

  public static async listUsers(req: Request, res: Response) {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    const active = typeof req.query.active === 'string' ? req.query.active : '';
    const filters: Record<string, unknown> = {};

    if (search) {
      const expression = { $regex: escapeRegExp(search), $options: 'i' };
      filters.$or = [{ userName: expression }, { email: expression }, { phone: expression }];
    }
    if (Object.values(Role).includes(role as Role)) filters.role = role;
    if (active === 'true' || active === 'false') filters.isActive = active === 'true';

    const [users, total] = await Promise.all([
      User.find(filters)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      User.countDocuments(filters)
    ]);

    return res.status(200).json({
      data: users.map(toSafeUser),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  }

  public static async getUser(req: Request, res: Response) {
    const userId = getUserId(req);
    if (!Types.ObjectId.isValid(userId)) return res.status(404).json({ error: 'UserNotFound' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'UserNotFound' });

    return res.status(200).json({ data: toSafeUser(user) });
  }

  public static async createUser(req: Request, res: Response) {
    const { input, details } = validateIdentity(req.body);
    if (!isValidSignupPassword(input.password)) details.password = 'Must contain 8 to 72 bytes';
    if (Object.keys(details).length) return res.status(400).json({ error: 'ValidationFailed', details });

    try {
      const user = new User({
        userName: (input.userName as string).trim(),
        email: (input.email as string).trim().toLowerCase(),
        phone: typeof input.phone === 'string' ? input.phone.trim() : undefined,
        role: input.role ?? Role.USER
      });
      await user.setPassword(input.password as string);
      await user.save();

      log.info({ adminId: req.userId, createdUserId: user._id, role: user.role }, 'Admin created user');
      return res.status(201).json({ data: toSafeUser(user) });
    } catch (error) {
      return respondWithPersistenceError(res, error, { adminId: req.userId });
    }
  }

  public static async updateUser(req: Request, res: Response) {
    const userId = getUserId(req);
    if (!Types.ObjectId.isValid(userId)) return res.status(404).json({ error: 'UserNotFound' });

    const { input, details } = validateIdentity(req.body, true);
    const editableFields = ['userName', 'email', 'phone', 'role'];
    if (!editableFields.some(field => field in input)) details.body = 'At least one editable field is required';
    if (Object.keys(details).length) return res.status(400).json({ error: 'ValidationFailed', details });
    if (userId === req.userId && 'role' in input && input.role !== Role.ADMIN) {
      return res.status(409).json({ error: 'CannotChangeOwnRole' });
    }

    const user = await User.findById(userId).select('+sessionVersion');
    if (!user) return res.status(404).json({ error: 'UserNotFound' });

    if ('userName' in input) user.userName = (input.userName as string).trim();
    if ('email' in input) user.email = (input.email as string).trim().toLowerCase();
    if ('phone' in input) user.phone = typeof input.phone === 'string' ? input.phone.trim() : undefined;
    if ('role' in input && input.role !== user.role) {
      user.role = input.role as Role;
      user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    }

    try {
      await user.save();
      log.info({ adminId: req.userId, updatedUserId: user._id }, 'Admin updated user');
      return res.status(200).json({ data: toSafeUser(user) });
    } catch (error) {
      return respondWithPersistenceError(res, error, { adminId: req.userId, userId });
    }
  }

  public static async resetUserPassword(req: Request, res: Response) {
    const userId = getUserId(req);
    const password = req.body?.password;
    if (!Types.ObjectId.isValid(userId)) return res.status(404).json({ error: 'UserNotFound' });
    if (!isValidSignupPassword(password)) return res.status(400).json({ error: 'InvalidPassword' });

    const user = await User.findById(userId).select('+password +sessionVersion');
    if (!user) return res.status(404).json({ error: 'UserNotFound' });

    await user.setPassword(password);
    user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    await user.save();

    log.info({ adminId: req.userId, updatedUserId: user._id }, 'Admin reset user password');
    return res.status(200).json({ message: 'PasswordChanged' });
  }

  public static async setUserStatus(req: Request, res: Response) {
    const userId = getUserId(req);
    const isActive = req.body?.isActive;
    if (!Types.ObjectId.isValid(userId)) return res.status(404).json({ error: 'UserNotFound' });
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'ValidationFailed', details: { isActive: 'Must be a boolean' } });
    }
    if (userId === req.userId && !isActive) return res.status(409).json({ error: 'CannotDisableOwnAccount' });

    const user = await User.findById(userId).select('+sessionVersion');
    if (!user) return res.status(404).json({ error: 'UserNotFound' });

    if (user.isActive !== isActive) {
      user.isActive = isActive;
      user.disabledAt = isActive ? undefined : new Date();
      user.sessionVersion = (user.sessionVersion ?? 0) + 1;
      await user.save();
    }

    log.info({ adminId: req.userId, updatedUserId: user._id, isActive }, 'Admin changed user status');
    return res.status(200).json({ data: toSafeUser(user) });
  }
}
