import { NextFunction, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import config from '../utilities/config/env.config';

interface AuthTokenPayload extends JwtPayload {
  userId?: string;
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authorization.slice('Bearer '.length).trim();

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthTokenPayload;

    if (!payload.userId) {
      return res.status(401).json({ error: 'InvalidToken' });
    }

    req.userId = payload.userId;
    return next();
  } catch {
    return res.status(401).json({ error: 'InvalidToken' });
  }
};
