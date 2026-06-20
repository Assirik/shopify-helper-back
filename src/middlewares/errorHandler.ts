import { ErrorRequestHandler } from 'express';
import log from '../utilities/logger/logger';

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  log.error(
    {
      err,
      method: req.method,
      path: req.originalUrl
    },
    'Unhandled API error'
  );

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({ error: 'InternalError' });
};
