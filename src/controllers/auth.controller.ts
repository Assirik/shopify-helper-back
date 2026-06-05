import { NextFunction, Request, Response } from 'express';
import { User, IUser } from '../models/User';
import jwt from 'jsonwebtoken';

export class AuthController {
  public static async signup(req: Request, res: Response) {
    const passwd = req.body.password;
    delete req.body.password;
    const user = new User(req.body);
    await user.setPassword(passwd);
    User.create(user)
      .then(() => res.status(201).json({ message: 'Successful' }))
      .catch((error: any) => res.status(400).json({ error }));
  }

  public static login(req: Request, res: Response) {
    console.log('Login attempt with body:', req.body);
    User.findOne({ userName: req.body.userName })
      .then(async user => {
        if (!user) {
          return res.status(401).json({ error: 'UserNotFound' });
        }
        if ((await user.isPasswordValid(req.body.password)) === false) {
          return res.status(401).json({ error: 'BadPassword' });
        }

        const retour: Partial<IUser> = user.toObject() as IUser;
        delete retour.password;
        res.status(200).json({
          userId: user._id,
          token: jwt.sign({ userId: user._id }, 'RANDOM_TOKEN_SECRET', { expiresIn: '365d' }),
          user: retour,
          message: 'Successful'
        });
      })
      .catch((error: any) => res.status(500).json({ error }));
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
