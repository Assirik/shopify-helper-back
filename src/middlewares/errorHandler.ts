import { ErrorRequestHandler } from 'express';
import log from '../utilities/logger/logger';
import { maskUrl } from '../utilities/logger/maskUrl';
import { captureApiError } from '../utilities/sentry/sentry';

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // req.log (pino-http) carries the request id; fall back to the shared logger without it.
  (req.log ?? log).error(
    {
      err,
      method: req.method,
      path: maskUrl(req.originalUrl)
    },
    'Unhandled API error'
  );

  captureApiError(err, req.id);

  if (res.headersSent) {
    return next(err);
  }

  return res.status(500).json({ error: 'InternalError' });
};
