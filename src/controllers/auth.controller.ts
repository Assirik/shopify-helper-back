import { NextFunction, Request, Response } from 'express';
import { User, IUser, Role } from '../models/User';
import jwt from 'jsonwebtoken';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';

const MIN_PASSWORD_LENGTH = 8;

export const isValidSignupPassword = (value: unknown): value is string => {
  return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH;
};

export class AuthController {
  public static async signup(req: Request, res: Response) {
    // if (!isValidSignupPassword(req.body?.password)) {
    //   return res.status(400).json({ error: 'InvalidPassword' });
    // }

    try {
      const passwd = req.body.password;
      const user = new User({
        userName: req.body.userName,
        email: req.body.email,
        phone: req.body.phone,
        role: Role.USER
      });
      await user.setPassword(passwd);
      await User.create(user);

      return res.status(201).json({ message: 'Successful' });
    } catch (error) {
      // L'erreur réelle (validation Mongoose, doublon userName/email) est loggée
      // pour le debug; la réponse expose un code string stable, conforme à ApiError.
      log.warn({ err: error, userName: req.body?.userName }, 'Signup failed');
      return res.status(400).json({ error: 'SignupFailed' });
    }
  }

  public static async login(req: Request, res: Response) {
    try {
      const user = await User.findOne({ userName: req.body.userName });

      if (!user) {
        return res.status(401).json({ error: 'UserNotFound' });
      }

      if ((await user.isPasswordValid(req.body.password)) === false) {
        return res.status(401).json({ error: 'BadPassword' });
      }

      const retour: Partial<IUser> = user.toObject() as IUser;
      delete retour.password;

      return res.status(200).json({
        userId: user._id,
        token: jwt.sign({ userId: user._id }, config.jwtSecret, { expiresIn: '365d' }),
        user: retour,
        message: 'Successful'
      });
    } catch (error) {
      log.error({ err: error, userName: req.body?.userName }, 'Login failed');
      return res.status(500).json({ error: 'InternalError' });
    }
  }

  public static async me(req: Request, res: Response) {
    try {
      const user = await User.findById(req.userId);

      if (!user) {
        return res.status(404).json({ error: 'UserNotFound' });
      }

      const retour: Partial<IUser> = user.toObject() as IUser;
      delete retour.password;

      return res.status(200).json({ user: retour });
    } catch (error) {
      log.error({ err: error, userId: req.userId }, 'Failed to load current user');
      return res.status(500).json({ error: 'InternalError' });
    }
  }

  public static async resetPassword(req: Request, res: Response) {
    try {
      const user = await User.findOne({ userName: req.body.userName });

      if (!user) return res.status(401).json({ error: 'UserNotFound' });
      await user.setPassword(req.body.password);
      user
        .save()
        .then(() => res.status(201).json({ message: 'Password changed successfully!' }))
        .catch(error => res.status(500).json({ error }));
    } catch (error) {
      return res.status(401).json({ error: 'InternalError' });
    }
  }

  public static userExist(req: Request, res: Response, next: NextFunction) {
    const userId = req.body?.userId ? req.body?.userId : req.params?.userId ? req.params?.userId : req.userId ? req.userId : '';
    User.findById(userId)
      .then(user => {
        if (!user) return res.status(406).json({ message: `user with _id: ${userId} doesn't exist` });
        next();
      })
      .catch(error => res.status(400).json({ error }));
  }
}
