import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import pinoHttp from 'pino-http';
import log, { serializeError } from '../utilities/logger/logger';
import { maskUrl } from '../utilities/logger/maskUrl';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const generateRequestId = (req: IncomingMessage, res: ServerResponse): string => {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
};

export const requestLogger = pinoHttp({
  logger: log,
  genReqId: generateRequestId,
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    // Client went away before the response was fully sent.
    if (!res.writableFinished) return 'warn';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  autoLogging: {
    ignore: (req) => {
      if (req.method === 'OPTIONS') return true; // CORS preflights
      const url = req.url ?? '';
      return url === '/api/health' || url.startsWith('/api/health?') || url.startsWith('/api/docs');
    }
  },
  serializers: {
    // pino-http installs its own standard `err` serializer on the child logger: override it.
    err: serializeError,
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: maskUrl(req.url),
      remoteAddress: req.raw?.ip ?? req.remoteAddress
    }),
    res: (res) => ({ statusCode: res.statusCode })
  }
});
