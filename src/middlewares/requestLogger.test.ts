import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// requestLogger.ts binds the shared logger at import time, so we capture its output
// by mocking the logger module with an in-memory pino instance.
const lines: Record<string, any>[] = [];
jest.mock('../utilities/logger/logger', () => {
  const { Writable: W } = jest.requireActual<typeof import('stream')>('stream');
  const p = jest.requireActual<typeof import('pino')>('pino');
  // Load the real options (real redact, serializers, ISO timestamp) as in production.
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const { loggerOptions, serializeError } = jest.requireActual<typeof import('../utilities/logger/logger')>('../utilities/logger/logger');
  process.env.NODE_ENV = previousEnv;
  const sink = new W({
    write(chunk, _enc, cb) {
      (globalThis as any).__obsLines.push(JSON.parse(chunk.toString()));
      cb();
    }
  });
  return { __esModule: true, default: p(loggerOptions, sink), serializeError };
});

import { requestLogger } from './requestLogger';
import { errorHandler } from './errorHandler';

const buildApp = () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(requestLogger);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/docs/x', (_req, res) => res.json({ ok: true }));
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/bad', (_req, res) => res.status(400).json({ error: 'x' }));
  app.get('/boom', (_req, res) => res.status(500).json({ error: 'x' }));
  app.get('/throw', () => {
    throw new Error('boom');
  });
  app.get('/axios', () => {
    const err: any = new Error('Request failed with status code 401');
    err.isAxiosError = true;
    err.name = 'AxiosError';
    err.code = 'ERR_BAD_REQUEST';
    err.config = {
      method: 'post',
      url: 'https://cw.example/x?access_token=URLSECRET',
      params: { access_token: 'PARAMSECRET' },
      data: '{"phone":"+221776986780"}',
      headers: { Authorization: 'Bearer AUTHSECRET', api_access_token: 'CWTOKEN' }
    };
    err.response = { status: 401, data: 'RESPSECRET' };
    throw err;
  });
  app.get('/dup', () => {
    const { MongoServerError } = jest.requireActual<typeof import('mongodb')>('mongodb');
    throw new MongoServerError({
      message: 'E11000 duplicate key error collection: shop.browsersessions index: phoneE164_1 dup key: { phoneE164: "+221776986780" }',
      code: 11000,
      keyPattern: { phoneE164: 1 },
      keyValue: { phoneE164: '+221776986780' }
    });
  });
  app.get('/validation', async (_req, _res, next) => {
    const mongoose = jest.requireActual<typeof import('mongoose')>('mongoose').default;
    const model = mongoose.models.ReqLogProbe ?? mongoose.model('ReqLogProbe', new mongoose.Schema({ phone: { type: String, minlength: 30 } }));
    next(await new model({ phone: '+221776986780' }).validate().catch((e: unknown) => e));
  });
  app.post('/json', express.json(), (_req, res) => res.json({ ok: true }));
  app.get('/abort', (req, res) => {
    // Client disconnects before any response is sent.
    res.on('close', () => undefined);
    req.socket.destroy();
  });
  app.use(errorHandler);
  return app;
};

beforeEach(() => {
  (globalThis as any).__obsLines = lines;
  lines.length = 0;
});
afterEach(() => {
  lines.length = 0;
});

describe('requestLogger', () => {
  it('generates an x-request-id when none is sent', async () => {
    const res = await request(buildApp()).get('/ok');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a valid incoming x-request-id', async () => {
    const res = await request(buildApp()).get('/ok').set('x-request-id', 'abc.DEF_123-x');
    expect(res.headers['x-request-id']).toBe('abc.DEF_123-x');
    expect(lines[0].req.id).toBe('abc.DEF_123-x');
  });

  it.each([['bad id with spaces'], ['a'.repeat(129)], ['a'.repeat(10000)], ['id;drop'], ['é']])(
    'replaces an invalid incoming x-request-id (%s)',
    async (value) => {
      const res = await request(buildApp()).get('/ok').set('x-request-id', value.slice(0, 10000));
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  );

  it('logs 2xx as info, 4xx as warn, 5xx as error', async () => {
    const app = buildApp();
    await request(app).get('/ok');
    await request(app).get('/bad');
    await request(app).get('/boom');
    expect(lines.map((l) => l.level)).toEqual([30, 40, 50]);
  });

  it('logs a thrown error as pino-http error line plus the errorHandler line, same request id, masked path', async () => {
    const res = await request(buildApp()).get('/throw?phone=%2B221776986780&page=2');
    expect(lines).toHaveLength(2);
    const handlerLine = lines.find((l) => l.msg === 'Unhandled API error')!;
    const requestLine = lines.find((l) => l.msg !== 'Unhandled API error')!;
    expect(requestLine.level).toBe(50);
    expect(requestLine.req.id).toBe(res.headers['x-request-id']);
    expect(handlerLine.reqId ?? handlerLine.req?.id).toBe(res.headers['x-request-id']);
    expect(handlerLine.path).toBe('/throw?phone=[Redacted]&page=2');
    expect(JSON.stringify(lines)).not.toContain('776986780');
  });

  it('keeps AxiosError secrets out of both the request line and the errorHandler line', async () => {
    await request(buildApp()).get('/axios');
    expect(lines).toHaveLength(2);
    const raw = JSON.stringify(lines);
    for (const secret of ['URLSECRET', 'PARAMSECRET', '776986780', 'AUTHSECRET', 'CWTOKEN', 'RESPSECRET']) {
      expect(raw).not.toContain(secret);
    }
    const handlerLine = lines.find((l) => l.msg === 'Unhandled API error')!;
    expect(handlerLine.err.code).toBe('ERR_BAD_REQUEST');
    expect(handlerLine.err.config.method).toBe('post');
  });

  it('keeps type Error for ordinary errors', async () => {
    await request(buildApp()).get('/throw');
    const handlerLine = lines.find((l) => l.msg === 'Unhandled API error')!;
    expect(handlerLine.err.type).toBe('Error');
    expect(handlerLine.err.message).toBe('boom');
  });

  it('keeps the phone of a duplicate-key error out of both lines (req.log)', async () => {
    await request(buildApp()).get('/dup');
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('776986780');
    const handlerLine = lines.find((l) => l.msg === 'Unhandled API error')!;
    expect(handlerLine.err.message).toBe('E11000 duplicate key error collection: shop.browsersessions index: phoneE164_1');
    expect(handlerLine.err).not.toHaveProperty('keyValue');
  });

  it('keeps rejected values of a ValidationError out of both lines (req.log)', async () => {
    await request(buildApp()).get('/validation');
    expect(JSON.stringify(lines)).not.toContain('776986780');
    expect(lines.find((l) => l.msg === 'Unhandled API error')!.err.type).toBe('ValidationError');
  });

  it('keeps the body of a malformed JSON request out of both lines (req.log)', async () => {
    await request(buildApp()).post('/json').set('Content-Type', 'application/json').send('{"phone":"+221776986780",');
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('776986780');
    expect(lines.some((l) => l.err && 'body' in l.err)).toBe(false);
  });

  it('logs a request aborted by the client at warn level', async () => {
    await request(buildApp()).get('/abort').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe(40);
  });

  it('writes ISO 8601 timestamps and no pid/hostname in production', async () => {
    await request(buildApp()).get('/ok');
    expect(lines[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('hostname');
  });

  it('logs remoteAddress from the trusted proxy hop only', async () => {
    await request(buildApp()).get('/ok').set('X-Forwarded-For', '6.6.6.6, 1.2.3.4');
    expect(lines[0].req.remoteAddress).toBe('1.2.3.4');
  });

  it('does not log CORS preflight requests', async () => {
    await request(buildApp()).options('/ok');
    expect(lines).toHaveLength(0);
  });

  it('does not log /api/health nor /api/docs', async () => {
    const app = buildApp();
    await request(app).get('/api/health');
    await request(app).get('/api/docs/x');
    expect(lines).toHaveLength(0);
  });

  it('keeps sensitive headers and URL secrets out of the log line', async () => {
    await request(buildApp())
      .get('/ok?hub.verify_token=SECRETTOKEN&access_token=ATOK&phone=%2B221776986780&page=2')
      .set('Authorization', 'Bearer JWTSECRET')
      .set('Cookie', 'sid=COOKIESECRET')
      .set('X-Hub-Signature-256', 'sha256=SIGSECRET')
      .set('X-Shopify-Hmac-Sha256', 'HMACSECRET')
      .set('X-Chatwoot-Signature', 'CWSECRET')
      .set('X-Bootstrap-Secret', 'BOOTSECRET');
    const raw = JSON.stringify(lines);
    for (const secret of ['SECRETTOKEN', 'ATOK', '776986780', 'JWTSECRET', 'COOKIESECRET', 'SIGSECRET', 'HMACSECRET', 'CWSECRET', 'BOOTSECRET']) {
      expect(raw).not.toContain(secret);
    }
    expect(lines[0].req.url).toContain('page=2');
    expect(lines[0].req).toEqual({ id: expect.any(String), method: 'GET', url: expect.any(String), remoteAddress: expect.any(String) });
    expect(lines[0].res).toEqual({ statusCode: 200 });
    expect(lines[0].responseTime).toEqual(expect.any(Number));
  });

  it('exposes req.log bound to the request id', async () => {
    const app = express();
    app.use(requestLogger);
    app.get('/x', (req, res) => {
      req.log.info('inside handler');
      res.end();
    });
    const res = await request(app).get('/x');
    const inner = lines.find((l) => l.msg === 'inside handler');
    expect(inner?.req?.id ?? inner?.reqId).toBe(res.headers['x-request-id']);
  });
});

describe('logger redact', () => {
  it('redacts sensitive headers if a serializer ever exposes them', () => {
    const log = jest.requireMock<{ default: import('pino').Logger }>('../utilities/logger/logger').default;
    log.info(
      {
        req: {
          headers: {
            authorization: 'Bearer JWTSECRET',
            cookie: 'c=COOKIESECRET',
            'x-hub-signature-256': 'SIGSECRET',
            'x-shopify-hmac-sha256': 'HMACSECRET',
            'x-chatwoot-signature': 'CWSECRET',
            'x-bootstrap-secret': 'BOOTSECRET'
          }
        }
      },
      'probe'
    );
    const raw = JSON.stringify(lines);
    for (const secret of ['JWTSECRET', 'COOKIESECRET', 'SIGSECRET', 'HMACSECRET', 'CWSECRET', 'BOOTSECRET']) {
      expect(raw).not.toContain(secret);
    }
  });
});
