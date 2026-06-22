import { timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import config from '../utilities/config/env.config';

const MIN_BOOTSTRAP_SECRET_LENGTH = 32;

export const isValidBootstrapSecret = (provided: unknown, expected: string) => {
  if (
    typeof provided !== 'string' ||
    expected.length < MIN_BOOTSTRAP_SECRET_LENGTH ||
    provided.length !== expected.length
  ) {
    return false;
  }

  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
};

export const requireBootstrapSecret = (req: Request, res: Response, next: NextFunction) => {
  if (config.initialAdminBootstrapSecret.length < MIN_BOOTSTRAP_SECRET_LENGTH) {
    return res.status(404).json({ error: 'BootstrapDisabled' });
  }

  if (!isValidBootstrapSecret(req.get('X-Bootstrap-Secret'), config.initialAdminBootstrapSecret)) {
    return res.status(401).json({ error: 'InvalidBootstrapSecret' });
  }

  return next();
};
