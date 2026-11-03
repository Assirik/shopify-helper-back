import path from 'path';
import logger, { LoggerOptions } from 'pino';
import '../config/env.config'; // loads dotenv before AXIOM_* is read
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

export const LOG_SERVICE_NAME = 'ecom-helper-back';
const MAX_ERROR_DEPTH = 5;

// Replaces every occurrence of the original message in the stack (V8 puts the message in the
// first line of `stack`), so a value removed from `message` does not come back through `stack`.
const scrubStack = (stack: unknown, original: unknown, replacement: string): string | undefined => {
  if (typeof stack !== 'string') return undefined;
  return typeof original === 'string' && original ? stack.split(original).join(replacement) : stack;
};

const isErrorLike = (value: unknown): boolean =>
  value instanceof Error ||
  (!!value && typeof value === 'object' && typeof (value as any).message === 'string' && typeof (value as any).stack === 'string');

// An AxiosError carries the whole request (headers, params, body, auth) in config/request/response.
// A MongoDB duplicate-key error carries the duplicated value (a phone number) in message, keyValue
// and errorResponse. A Mongoose ValidationError / CastError carries the rejected values.
// A body-parser JSON error carries the raw body and a snippet of it in its message.
// An ioredis error can carry the command that failed, AUTH included, with the password in its args.
// Keep only what is needed to understand the failure: types, codes, paths, index names.
// pino-http calls its `err` serializer with an object already flattened by pino-std-serializers,
// whose `raw` property is the original error: unwrap it first (but never replace a real Error).
// `cause` and error-valued properties go through the same filter.
export const serializeError = (input: unknown, depth = 0): any => {
  const err =
    (!(input instanceof Error) && input && typeof input === 'object' && 'raw' in input && (input as any).raw) || input;
  const e = err as any;
  if (e && e.isAxiosError) {
    return {
      type: 'AxiosError',
      message: e.message,
      stack: e.stack,
      code: e.code,
      config: { method: e.config?.method, url: maskUrl(e.config?.url) },
      response: e.response ? { status: e.response.status } : undefined
    };
  }
  if (e && typeof e === 'object' && typeof e.message === 'string') {
    // MongoServerError / MongoBulkWriteError E11000: keep the collection and the index name only.
    if (e.code === 11000 || e.message.startsWith('E11000')) {
      const dupKeyAt = e.message.indexOf(' dup key');
      const message = dupKeyAt > 0 ? e.message.slice(0, dupKeyAt) : 'E11000 duplicate key error';
      return {
        type: e.name ?? 'MongoServerError',
        message,
        stack: scrubStack(e.stack, e.message, message),
        code: e.code ?? 11000
      };
    }
    // Mongoose ValidationError: keep the paths and the kind of failure, drop the rejected values.
    if (e.name === 'ValidationError' && e.errors && typeof e.errors === 'object') {
      const errors: Record<string, { name?: string; kind?: string; path?: string }> = {};
      for (const [key, sub] of Object.entries<any>(e.errors)) {
        errors[key] = { name: sub?.name, kind: sub?.kind, path: sub?.path ?? key };
      }
      const model = /^(.*?) validation failed/.exec(e.message)?.[1];
      const message = `${model ? `${model} validation failed` : 'Validation failed'}: ${Object.keys(errors).join(', ')}`;
      return { type: 'ValidationError', message, stack: scrubStack(e.stack, e.message, message), errors };
    }
    // Mongoose ValidatorError on its own: keep the path and the kind of failure.
    if (e.name === 'ValidatorError') {
      const message = `Validator failed at path "${e.path}" (${e.kind})`;
      return { type: 'ValidatorError', message, stack: scrubStack(e.stack, e.message, message), kind: e.kind, path: e.path };
    }
    // Mongoose CastError: keep the path and the target type, drop the value.
    if (e.name === 'CastError') {
      const modelName = e.model?.modelName;
      const message = `Cast to ${e.kind} failed at path "${e.path}"${modelName ? ` for model "${modelName}"` : ''}`;
      return {
        type: 'CastError',
        message,
        stack: scrubStack(e.stack, e.message, message),
        kind: e.kind,
        path: e.path
      };
    }
    // body-parser JSON failure: `body` is the raw payload, and V8 quotes a snippet of it in the message.
    if (e.type === 'entity.parse.failed' || (e instanceof SyntaxError && 'body' in e)) {
      const message = 'Request body is not valid JSON';
      const { body: _body, ...rest } = logger.stdSerializers.err(err as Error) as any;
      return { ...rest, message, stack: scrubStack(e.stack, e.message, message) };
    }
  }
  const out = logger.stdSerializers.err(err as Error) as any;
  if (!out || typeof out !== 'object' || !e || typeof e !== 'object') return out;
  // Any other command object (ioredis AUTH...): keep the command name, never its arguments.
  if (out.command && typeof out.command === 'object') out.command = { name: out.command.name };
  // MongoDB driver payloads: documents and values the server echoes back.
  if (typeof e.name === 'string' && e.name.startsWith('Mongo')) {
    delete out.errInfo;
    delete out.errorResponse;
    delete out.keyValue;
    delete out.keyPattern;
  }
  if (depth >= MAX_ERROR_DEPTH) {
    delete out.cause;
    return out;
  }
  // pino-std-serializers folds the cause into message and stack: put the plain ones back and
  // filter the cause itself.
  if (e.cause !== undefined && e.cause !== null) {
    out.message = e.message;
    out.stack = e.stack;
    out.cause = isErrorLike(e.cause) ? serializeError(e.cause, depth + 1) : '[Unserializable cause]';
  }
  for (const key of Object.keys(out)) {
    if (key === 'cause') continue;
    const original = e[key];
    if (isErrorLike(original)) out[key] = serializeError(original, depth + 1);
  }
  // AggregateError: pino-std-serializers copies the members unfiltered into `aggregateErrors`.
  if (Array.isArray(e.errors) && e.errors.every(isErrorLike)) {
    const members = e.errors.map((item: unknown) => serializeError(item, depth + 1));
    if ('aggregateErrors' in out) out.aggregateErrors = members;
    if ('errors' in out) out.errors = members;
  } else {
    delete out.aggregateErrors;
  }
  return out;
};

const hasValue = (value: string | undefined) => !!value && value.trim() !== '';

// AXIOM_URL (optional): the dataset's edge deployment. Anything but https is refused, except a
// local fake server (tests): the token travels in every request. Trailing slashes are removed.
// Returns undefined for "not set", null for "set but refused".
const resolveAxiomUrl = (raw: string | undefined): string | null | undefined => {
  if (!hasValue(raw)) return undefined;
  try {
    const url = new URL(raw!.trim());
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

const axiomUrl = resolveAxiomUrl(process.env.AXIOM_URL);
if (axiomUrl === null) {
  // Never echo the value: it could carry credentials.
  process.stderr.write('[axiom-log-transport] AXIOM_URL ignored, Axiom log shipping disabled: only https URLs (or http on localhost) are accepted\n');
}

// Axiom is never used under Jest or NODE_ENV=test, even when a local .env defines AXIOM_*:
// tests must not ship anything anywhere.
const axiomEnabled =
  hasValue(process.env.AXIOM_TOKEN) &&
  hasValue(process.env.AXIOM_DATASET) &&
  axiomUrl !== null &&
  process.env.NODE_ENV !== 'test' &&
  process.env.JEST_WORKER_ID === undefined;

// Development: readable output through pino-pretty. Production: raw JSON on stdout.
const prettyTarget = {
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname,service,env', // common fields are for Axiom; keep the dev output unchanged
    singleLine: true,
    errorLikeObjectKeys: ['err', 'error', 'stack'] // Ensures stack traces are shown
  }
};

const redactSecret = (text: string): string => {
  const token = process.env.AXIOM_TOKEN?.trim();
  return token ? text.split(token).join('[Redacted]') : text;
};

let axiomStream: any;
let axiomStreamDead = false;

// The Axiom stream lives in its own worker thread and is NOT the only destination: stdout stays a
// plain synchronous destination of the main thread (as before), so a dead Axiom worker can neither
// crash the API nor swallow the logs. Whatever happens to the worker, one line goes to stderr, once.
export const guardAxiomStream = <T extends { on: (event: string, listener: (...args: any[]) => void) => unknown }>(stream: T): T => {
  let reported = false;
  stream.on('error', (err: any) => {
    axiomStreamDead = true;
    if (reported) return;
    reported = true;
    try {
      process.stderr.write(
        redactSecret(`[axiom-log-transport] transport stopped, logs keep going to stdout only: ${err?.name ?? 'Error'}: ${err?.message ?? ''}\n`)
      );
    } catch {
      // stderr is best effort
    }
  });
  stream.on('close', () => {
    axiomStreamDead = true;
  });
  return stream;
};

const buildAxiomStream = () => {
  const extension = path.extname(__filename) || '.js';
  return guardAxiomStream(
    logger.transport({
      target: path.join(__dirname, `axiomTransport${extension}`),
      options: {
        dataset: process.env.AXIOM_DATASET!.trim(),
        token: process.env.AXIOM_TOKEN!.trim(),
        // Optional: another edge deployment; the transport defaults to US East 1.
        ...(axiomUrl ? { url: axiomUrl } : {})
      }
    })
  );
};

export const loggerOptions: LoggerOptions = {
  // Common fields on every line; pid and hostname stay out.
  base: { service: LOG_SERVICE_NAME, env: process.env.NODE_ENV || 'development' },
  timestamp: logger.stdTimeFunctions.isoTime,
  redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
  // Without Axiom, development keeps pino-pretty as the single transport and production writes to stdout.
  ...(!axiomEnabled && !isProduction ? { transport: prettyTarget } : {}),
  serializers: {
    err: serializeError
  }
};

// The serializers, redaction, timestamp and base fields all run in the main thread BEFORE a line
// reaches any destination, so Axiom receives exactly what stdout receives.
const buildDestination = () => {
  if (!axiomEnabled) return undefined;
  axiomStream = buildAxiomStream();
  return logger.multistream([
    { stream: isProduction ? logger.destination(1) : logger.transport(prettyTarget) },
    { stream: axiomStream }
  ]);
};

const destination = buildDestination();
const log = destination ? logger(loggerOptions, destination) : logger(loggerOptions);

// Ends the Axiom worker (its `close` ships what is left, in 1.5 s at most) and waits for it, bounded by
// `timeoutMs` on this side too. Without Axiom, stdout is synchronous: nothing to wait for.
// The logger must not be used afterwards.
export const closeLogger = (timeoutMs = 2000): Promise<void> =>
  new Promise(resolve => {
    if (!axiomStream || axiomStreamDead || typeof axiomStream.end !== 'function') {
      resolve();
      return;
    }
    // Not unref'd: it keeps the process alive until the worker has shipped its last batch.
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    axiomStream.once('close', done);
    axiomStream.once('error', done);
    try {
      axiomStream.end();
    } catch {
      done();
    }
  });

export default log;
