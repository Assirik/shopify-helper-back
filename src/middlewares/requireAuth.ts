import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../utilities/config/env.config';
import { User } from '../models/User';

interface AuthTokenPayload extends JwtPayload {
  userId?: string;
  sessionVersion?: number;
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authorization.slice('Bearer '.length).trim();

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let payload: AuthTokenPayload;

  try {
    payload = jwt.verify(token, config.jwtSecret) as AuthTokenPayload;
  } catch {
    return res.status(401).json({ error: 'InvalidToken' });
  }

  try {
    if (!payload.userId || typeof payload.sessionVersion !== 'number') {
      return res.status(401).json({ error: 'InvalidToken' });
    }

    const user = await User.findById(payload.userId).select('+sessionVersion isActive role');

    if (!user || user.isActive === false || (user.sessionVersion ?? 0) !== payload.sessionVersion) {
      return res.status(401).json({ error: 'InvalidToken' });
    }

    req.userId = payload.userId;
    req.user = user;
    return next();
  } catch {
    return res.status(500).json({ error: 'AuthenticationFailed' });
  }
};
