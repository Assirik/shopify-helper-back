import logger, { LoggerOptions } from 'pino';
import { maskUrl } from './maskUrl';

const isProduction = process.env.NODE_ENV === 'production';

// Safety net: header values that must never reach a log line, even if a serializer
// starts exposing headers by mistake.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-shopify-hmac-sha256"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-chatwoot-signature"]',
  'req.headers["x-bootstrap-secret"]'
];

// An AxiosError carries the whole request (headers, params, body, auth) in config/request/response.
// Keep only what is needed to understand the failure.
// pino-http calls its `err` serializer with an object already flattened by pino-std-serializers,
// whose `raw` property is the original error: unwrap it first.
export const serializeError = (input: unknown) => {
  const err = (input && typeof input === 'object' && 'raw' in input && (input as any).raw) || input;
  const e = err as any;
  if (e && e.isAxiosError) {
    return {
      type: e.name ?? 'AxiosError',
      message: e.message,
      stack: e.stack,
      code: e.code,
      config: { method: e.config?.method, url: maskUrl(e.config?.url) },
      response: e.response ? { status: e.response.status } : undefined
    };
  }
  return logger.stdSerializers.err(err as Error);
};

export const loggerOptions: LoggerOptions = {
  // No base: drops pid and hostname from every line.
  base: undefined,
  timestamp: logger.stdTimeFunctions.isoTime,
  redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
  // Development: readable output through pino-pretty. Production: raw JSON on stdout.
  // Further targets (Axiom, ...) are added later by turning `transport` into a list of targets.
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
            singleLine: true,
            errorLikeObjectKeys: ['err', 'error', 'stack'] // Ensures stack traces are shown
          }
        }
      }),
  serializers: {
    err: serializeError
  }
};

const log = logger(loggerOptions);

export default log;
