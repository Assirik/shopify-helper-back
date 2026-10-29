import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import { Redis } from 'ioredis';
import config from '../utilities/config/env.config';
import { BrowserSession } from '../models/BrowserSession';
import { getRedisConnection } from '../queues/notification.queue';
import { PhoneNormalizationService } from '../utilities/services/phoneNormalization.service';
import log from '../utilities/logger/logger';

/**
 * POST /api/session — browser signals sent by the Shopify theme script (`theme/session.js`)
 * when the customer types a phone number. Body is `text/plain` holding JSON (sendBeacon, no
 * CORS preflight); the browser never reads the response.
 */

export const SESSION_BODY_LIMIT = '4kb';
export const SESSION_RATE_LIMIT_MAX = 30;
export const SESSION_RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_KEY_PREFIX = 'session-capture:rate';
const REDIS_WARN_INTERVAL_MS = 60 * 1000;
// After a Redis failure the limiter is skipped for this long, then a fresh client is created.
export const SESSION_RATE_LIMIT_BYPASS_MS = 30 * 1000;

const FIELD_MAX_LENGTHS = {
  phone: 32,
  fbp: 255,
  fbc: 512,
  fbclid: 512,
  userAgent: 512,
  pageUrl: 2048
} as const;

type NullableField = 'fbp' | 'fbc' | 'fbclid';
type RequiredField = 'userAgent' | 'pageUrl';
const NULLABLE_FIELDS: NullableField[] = ['fbp', 'fbc', 'fbclid'];
const REQUIRED_FIELDS: RequiredField[] = ['userAgent', 'pageUrl'];
const SIGNAL_FIELDS = [...NULLABLE_FIELDS, ...REQUIRED_FIELDS];

// Logs never carry the full phone (the record itself is deleted after one hour).
const maskPhone = (phoneE164: string) => `***${phoneE164.slice(-4)}`;

export interface SessionCapture {
  phoneE164: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  userAgent?: string;
  pageUrl?: string;
}

export type SessionCaptureValidation =
  | { ok: true; value: SessionCapture }
  | { ok: false; error: string; details?: Record<string, string> };

const normalizeOrigin = (origin: string) => origin.trim().toLowerCase().replace(/\/+$/, '');

// Only the shop storefront may post. Missing origin, unknown origin or empty list => 403.
export const requireAllowedSessionOrigin: RequestHandler = (req, res, next) => {
  const allowedOrigins = config.sessionCapture.allowedOrigins;
  const origin = req.get('Origin');

  if (!origin || allowedOrigins.length === 0 || !allowedOrigins.includes(normalizeOrigin(origin))) {
    log.warn(
      { origin: origin ?? null, allowedOriginCount: allowedOrigins.length },
      'Rejected browser session capture from a non-allowed origin'
    );
    return res.status(403).json({ error: 'OriginNotAllowed' });
  }

  return next();
};

let rateLimitRedis: Redis | null = null;
let rateLimitBypassUntil = 0;
let lastRedisWarnAt = 0;

const warnRedisUnavailable = (err: unknown) => {
  const now = Date.now();
  if (now - lastRedisWarnAt >= REDIS_WARN_INTERVAL_MS) {
    lastRedisWarnAt = now;
    log.warn({ err }, 'Session capture rate limit unavailable (Redis), requests are allowed');
  }
};

// Dedicated client that fails fast: no offline queue, one retry, short command timeout.
// The BullMQ connection settings (maxRetriesPerRequest: null) would block a request while
// Redis is down, which must never happen here.
// A client still connecting (or reconnecting) is kept: never create a second one meanwhile.
// Only a client that gave up for good ('end') is replaced.
const getRateLimitRedis = () => {
  if (!rateLimitRedis || rateLimitRedis.status === 'end') {
    rateLimitRedis = new Redis({
      ...getRedisConnection(),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 500
    });
    rateLimitRedis.on('error', warnRedisUnavailable);
  }

  return rateLimitRedis;
};

// A timed-out command on a ready client stays in ioredis' internal queue: drop the client
// (which flushes the queue) and skip the limiter for a while, instead of piling up commands
// on a connected but mute Redis.
const resetRateLimitRedis = () => {
  const client = rateLimitRedis;
  rateLimitRedis = null;
  rateLimitBypassUntil = Date.now() + SESSION_RATE_LIMIT_BYPASS_MS;

  try {
    client?.disconnect();
  } catch (err) {
    warnRedisUnavailable(err);
  }
};

// Fixed one-minute window per IP. Redis unavailable => the request goes through.
export const limitSessionCaptureRate = async (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || 'unknown';
  const windowId = Math.floor(Date.now() / (SESSION_RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `${RATE_LIMIT_KEY_PREFIX}:${ip}:${windowId}`;
  let count: number;

  if (Date.now() < rateLimitBypassUntil) {
    return next();
  }

  const client = getRateLimitRedis();

  // Not connected yet (or reconnecting): accept without counting and keep the client as is.
  // With enableOfflineQueue: false a command sent now would fail immediately.
  if (client.status !== 'ready') {
    return next();
  }

  try {
    const results = await client
      .multi()
      .incr(key)
      .expire(key, SESSION_RATE_LIMIT_WINDOW_SECONDS)
      .exec();
    const [incrError, value] = results?.[0] ?? [new Error('Empty Redis transaction result'), null];

    if (incrError) {
      throw incrError;
    }

    count = Number(value);
  } catch (err) {
    warnRedisUnavailable(err);
    resetRateLimitRedis();
    return next();
  }

  if (count > SESSION_RATE_LIMIT_MAX) {
    log.warn({ ip, count }, 'Rate limited browser session capture');
    return res.status(429).json({ error: 'TooManyRequests' });
  }

  return next();
};

const textParser = express.text({ type: 'text/plain', limit: SESSION_BODY_LIMIT });

// Route-scoped text/plain parser; any parser error (oversized body, bad charset) => 400.
export const parseSessionBody: RequestHandler = (req, res, next) => {
  textParser(req, res, (err?: unknown) => {
    if (err) {
      const type = (err as { type?: string }).type;
      return res.status(400).json({ error: type === 'entity.too.large' ? 'PayloadTooLarge' : 'InvalidBody' });
    }

    return next();
  });
};

export const validateSessionCapture = (rawBody: unknown): SessionCaptureValidation => {
  if (typeof rawBody !== 'string' || rawBody.length === 0) {
    return { ok: false, error: 'InvalidBody' };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'InvalidJson' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'InvalidBody' };
  }

  const body = parsed as Record<string, unknown>;
  const details: Record<string, string> = {};
  const value: Partial<SessionCapture> = {};

  if (typeof body.phone !== 'string' || body.phone.trim().length === 0) {
    details.phone = 'phone is required and must be a string';
  } else if (body.phone.length > FIELD_MAX_LENGTHS.phone) {
    details.phone = `phone must be at most ${FIELD_MAX_LENGTHS.phone} characters`;
  }

  // fbp / fbc / fbclid may be absent or null; userAgent and pageUrl are required strings.
  for (const field of SIGNAL_FIELDS) {
    const fieldValue = body[field];
    const required = (REQUIRED_FIELDS as string[]).includes(field);

    if (!required && (fieldValue === undefined || fieldValue === null)) {
      continue;
    }

    if (typeof fieldValue !== 'string' || (required && fieldValue.trim().length === 0)) {
      details[field] = required ? `${field} is required and must be a string` : `${field} must be a string or null`;
      continue;
    }

    if (fieldValue.length > FIELD_MAX_LENGTHS[field]) {
      details[field] = `${field} must be at most ${FIELD_MAX_LENGTHS[field]} characters`;
      continue;
    }

    const trimmed = fieldValue.trim();

    if (trimmed) {
      value[field] = trimmed;
    }
  }

  if (Object.keys(details).length > 0) {
    return { ok: false, error: 'ValidationFailed', details };
  }

  // normalizeSenegalPhone does not know the "00" international prefix (00221…): map it to "+".
  const phone = PhoneNormalizationService.normalizeSenegalPhone((body.phone as string).trim().replace(/^00/, '+'));

  if (!phone.isValid || !phone.e164) {
    return { ok: false, error: 'InvalidPhone' };
  }

  return { ok: true, value: { ...value, phoneE164: phone.e164 } };
};

export class BrowserSessionController {
  public static async capture(req: Request, res: Response) {
    const validation = validateSessionCapture(req.body);

    if (!validation.ok) {
      return res.status(400).json({
        error: validation.error,
        ...(validation.details ? { details: validation.details } : {})
      });
    }

    const { phoneE164, ...signals } = validation.value;
    // IP as seen by the server, never taken from the body.
    const fields: Record<string, string | undefined> = { ...signals, ip: req.ip || undefined };
    const $set: Record<string, string> = {};
    const $unset: Record<string, ''> = {};

    // Latest capture wins: fields absent from this capture are removed, not kept.
    for (const field of [...SIGNAL_FIELDS, 'ip']) {
      const fieldValue = fields[field];
      if (fieldValue) {
        $set[field] = fieldValue;
      } else {
        $unset[field] = '';
      }
    }

    await BrowserSession.findOneAndUpdate(
      { phoneE164 },
      { $set, ...(Object.keys($unset).length > 0 ? { $unset } : {}) },
      { upsert: true, setDefaultsOnInsert: true }
    );

    log.info(
      {
        phone: maskPhone(phoneE164),
        hasFbp: Boolean(signals.fbp),
        hasFbc: Boolean(signals.fbc),
        hasFbclid: Boolean(signals.fbclid),
        hasUserAgent: Boolean(signals.userAgent)
      },
      'Captured browser session'
    );

    return res.status(204).end();
  }
}
