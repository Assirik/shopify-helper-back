import { NextFunction, Request, Response } from 'express';
import { Role, User } from '../models/User';

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await User.findById(req.userId).select('role');

    if (!user) {
      return res.status(401).json({ error: 'InvalidToken' });
    }

    if (user.role !== Role.ADMIN) {
      return res.status(403).json({ error: 'AdminRequired' });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(500).json({ error: 'AdminAuthorizationFailed' });
  }
};
