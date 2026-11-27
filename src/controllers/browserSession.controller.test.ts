import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// In-memory stand-in for the rate limit Redis: counts INCR per key, or fails on demand.
// Like ioredis, a command that times out stays in the client's queue until disconnect().
// `status` mirrors ioredis ('connecting', 'reconnecting', 'ready', 'end'…).
interface MockRedisClient {
  status: string;
  commandQueue: unknown[];
  disconnected: boolean;
  execCalls: number;
  emit: (event: string, payload: unknown) => void;
}

const mockRedisState: {
  counts: Map<string, number>;
  failure: 'reject' | 'incrError' | 'timeout' | null;
  initialStatus: string;
  instances: MockRedisClient[];
} = {
  counts: new Map(),
  failure: null,
  initialStatus: 'ready',
  instances: []
};

jest.mock('ioredis', () => ({
  Redis: class {
    status = mockRedisState.initialStatus;
    commandQueue: unknown[] = [];
    disconnected = false;
    execCalls = 0;
    listeners = new Map<string, Array<(payload: unknown) => void>>();

    constructor() {
      mockRedisState.instances.push(this);
    }

    on(event: string, listener: (payload: unknown) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    emit(event: string, payload: unknown) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(payload);
      }
    }

    disconnect() {
      this.disconnected = true;
      this.status = 'end';
      this.commandQueue = [];
    }

    multi() {
      let key = '';
      const chain = {
        incr: (k: string) => {
          key = k;
          return chain;
        },
        expire: () => chain,
        exec: async () => {
          this.execCalls += 1;
          if (this.status !== 'ready') {
            // ioredis with enableOfflineQueue: false rejects at once while not connected.
            throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
          }
          if (mockRedisState.failure === 'timeout') {
            this.commandQueue.push({ key });
            throw new Error('Command timed out');
          }
          if (mockRedisState.failure === 'reject') {
            throw new Error('connect ECONNREFUSED');
          }
          if (mockRedisState.failure === 'incrError') {
            return [[new Error('READONLY'), null], [null, 1]];
          }
          const count = (mockRedisState.counts.get(key) ?? 0) + 1;
          mockRedisState.counts.set(key, count);
          return [[null, count], [null, 1]];
        }
      };
      return chain;
    }
  }
}));

// Same pattern as errorHandler.test.ts: no pino transport worker in this suite.
jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../queues/notification.queue', () => ({
  getRedisConnection: () => ({ host: 'localhost', port: 6379, maxRetriesPerRequest: null })
}));

import config from '../utilities/config/env.config';
import { BrowserSession } from '../models/BrowserSession';
import browserSessionRouter from '../routes/browserSession';
import log from '../utilities/logger/logger';
import { SESSION_RATE_LIMIT_BYPASS_MS, SESSION_RATE_LIMIT_MAX } from './browserSession.controller';

const SHOP_ORIGIN = 'https://shop.example.com';

type StoredSession = Record<string, string>;

// Applies the upsert like MongoDB would, so "latest capture wins" is checked on the result.
const store = new Map<string, StoredSession>();
let upsertSpy: ReturnType<typeof jest.spyOn>;

const buildApp = () => {
  const app = express();
  // Same proxy setting and global parser as src/app.ts: the parser must not swallow the text/plain body.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/session', browserSessionRouter);
  return app;
};

const validBody = (overrides: Record<string, unknown> = {}) => ({
  phone: '77 698 67 80',
  fbp: 'fb.1.1730000000000.111',
  fbc: 'fb.1.1730000000000.abc',
  fbclid: 'abc',
  userAgent: 'Mozilla/5.0 (Test)',
  pageUrl: 'https://shop.example.com/products/x?fbclid=abc',
  ...overrides
});

const post = (body: unknown, origin: string | null = SHOP_ORIGIN, app = buildApp()) => {
  const req = request(app).post('/api/session').set('Content-Type', 'text/plain;charset=UTF-8');
  if (origin !== null) {
    req.set('Origin', origin);
  }
  return req.send(typeof body === 'string' ? body : JSON.stringify(body));
};

// Each test runs one hour after the previous one, so a Redis bypass never leaks between tests.
let clock = Date.UTC(2026, 9, 29, 12, 0, 0);

beforeEach(() => {
  clock += 60 * 60 * 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  // Ending the previous clients makes the controller create a fresh one in each test.
  for (const client of mockRedisState.instances) {
    client.status = 'end';
  }
  mockRedisState.instances = [];
  mockRedisState.initialStatus = 'ready';
  config.sessionCapture.allowedOrigins = [SHOP_ORIGIN, 'https://www.shop.example.com'];
  mockRedisState.counts.clear();
  mockRedisState.failure = null;
  store.clear();
  upsertSpy = jest.spyOn(BrowserSession, 'findOneAndUpdate').mockImplementation(((
    filter: { phoneE164: string },
    update: { $set: StoredSession; $unset?: Record<string, ''> }
  ) => {
    const current = { ...(store.get(filter.phoneE164) ?? { phoneE164: filter.phoneE164 }) };
    Object.assign(current, update.$set);
    for (const field of Object.keys(update.$unset ?? {})) {
      delete current[field];
    }
    store.set(filter.phoneE164, current);
    return Promise.resolve(current);
  }) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/session — phone normalization', () => {
  it.each(['77 698 67 80', '776986780', '+221776986780', '00221776986780'])(
    'stores %p under +221776986780',
    async phone => {
      const response = await post(validBody({ phone }));

      expect(response.status).toBe(204);
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy.mock.calls[0]?.[0]).toEqual({ phoneE164: '+221776986780' });
      expect(upsertSpy.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ upsert: true }));
    }
  );
});

describe('POST /api/session — storage', () => {
  it('stores the browser signals and the server-side IP, never an IP from the body', async () => {
    const response = await post(validBody({ ip: '6.6.6.6' }));

    expect(response.status).toBe(204);
    const stored = store.get('+221776986780');
    expect(stored).toEqual({
      phoneE164: '+221776986780',
      fbp: 'fb.1.1730000000000.111',
      fbc: 'fb.1.1730000000000.abc',
      fbclid: 'abc',
      userAgent: 'Mozilla/5.0 (Test)',
      pageUrl: 'https://shop.example.com/products/x?fbclid=abc',
      ip: expect.any(String)
    });
    expect(stored?.ip).not.toBe('6.6.6.6');
  });

  it('keeps one record per phone and the latest capture wins', async () => {
    const app = buildApp();
    await post(validBody(), SHOP_ORIGIN, app);
    const response = await post(
      validBody({ phone: '+221776986780', fbp: 'fb.1.2.second', fbc: null, fbclid: null, pageUrl: 'https://shop.example.com/cart' }),
      SHOP_ORIGIN,
      app
    );

    expect(response.status).toBe(204);
    expect(store.size).toBe(1);
    expect(store.get('+221776986780')).toEqual({
      phoneE164: '+221776986780',
      fbp: 'fb.1.2.second',
      userAgent: 'Mozilla/5.0 (Test)',
      pageUrl: 'https://shop.example.com/cart',
      ip: expect.any(String)
    });
  });

  it('accepts absent fbp, fbc and fbclid', async () => {
    const response = await post({ phone: '776986780', userAgent: 'Mozilla/5.0 (Test)', pageUrl: 'https://shop.example.com/' });

    expect(response.status).toBe(204);
    expect(store.get('+221776986780')).toEqual({
      phoneE164: '+221776986780',
      userAgent: 'Mozilla/5.0 (Test)',
      pageUrl: 'https://shop.example.com/',
      ip: expect.any(String)
    });
  });

  it('never logs the full phone number', async () => {
    const logInfo = jest.spyOn(log, 'info');

    const response = await post(validBody());

    expect(response.status).toBe(204);
    expect(logInfo).toHaveBeenCalled();
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain('776986780');
    expect(JSON.stringify(logInfo.mock.calls)).toContain('***6780');
  });
});

describe('POST /api/session — invalid body', () => {
  it.each<[string, unknown, string]>([
    ['invalid JSON', '{"phone": "776986780"', 'InvalidJson'],
    ['empty body', '', 'InvalidBody'],
    ['JSON array', [], 'InvalidBody'],
    ['JSON null', 'null', 'InvalidBody'],
    ['missing phone', { fbp: 'x' }, 'ValidationFailed'],
    ['empty phone', { phone: '   ' }, 'ValidationFailed'],
    ['phone of wrong type', { phone: 776986780 }, 'ValidationFailed'],
    ['phone too long', { phone: '7'.repeat(33) }, 'ValidationFailed'],
    ['unnormalizable phone', validBody({ phone: '12345' }), 'InvalidPhone'],
    ['foreign phone', validBody({ phone: '+33612345678' }), 'InvalidPhone'],
    ['fbp of wrong type', validBody({ fbp: 42 }), 'ValidationFailed'],
    ['userAgent of wrong type', validBody({ userAgent: { a: 1 } }), 'ValidationFailed'],
    ['userAgent absent', { phone: '776986780', pageUrl: 'https://shop.example.com/' }, 'ValidationFailed'],
    ['userAgent null', validBody({ userAgent: null }), 'ValidationFailed'],
    ['userAgent blank', validBody({ userAgent: '   ' }), 'ValidationFailed'],
    ['pageUrl absent', { phone: '776986780', userAgent: 'Mozilla/5.0 (Test)' }, 'ValidationFailed'],
    ['pageUrl null', validBody({ pageUrl: null }), 'ValidationFailed'],
    ['pageUrl of wrong type', validBody({ pageUrl: 42 }), 'ValidationFailed'],
    ['userAgent too long', validBody({ userAgent: 'a'.repeat(513) }), 'ValidationFailed'],
    ['pageUrl too long', validBody({ pageUrl: 'https://x/' + 'a'.repeat(2048) }), 'ValidationFailed']
  ])('rejects %s with 400 and no write', async (_label, body, error) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects a body over 4 kB with 400 and no write', async () => {
    const response = await post(validBody({ pageUrl: 'a'.repeat(5000) }));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('PayloadTooLarge');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects a non text/plain body with 400 and no write', async () => {
    const response = await request(buildApp())
      .post('/api/session')
      .set('Origin', SHOP_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(validBody()));

    expect(response.status).toBe(400);
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/session — origin check', () => {
  it('rejects a missing Origin header with 403', async () => {
    const response = await post(validBody(), null);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('OriginNotAllowed');
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects an origin that is not listed with 403', async () => {
    const response = await post(validBody(), 'https://evil.example.com');

    expect(response.status).toBe(403);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('rejects everything when the allowed list is empty', async () => {
    config.sessionCapture.allowedOrigins = [];

    const response = await post(validBody(), SHOP_ORIGIN);

    expect(response.status).toBe(403);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('accepts a listed origin regardless of case and trailing slash', async () => {
    const response = await post(validBody(), 'HTTPS://WWW.Shop.Example.com/');

    expect(response.status).toBe(204);
  });
});

describe('POST /api/session — rate limit', () => {
  it(`accepts ${SESSION_RATE_LIMIT_MAX} captures per minute per IP and rejects the next one with 429`, async () => {
    const app = buildApp();

    for (let i = 0; i < SESSION_RATE_LIMIT_MAX; i++) {
      const response = await post(validBody(), SHOP_ORIGIN, app);
      expect(response.status).toBe(204);
    }

    const limited = await post(validBody(), SHOP_ORIGIN, app);

    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('TooManyRequests');
    expect(upsertSpy).toHaveBeenCalledTimes(SESSION_RATE_LIMIT_MAX);
  });

  it('counts per client IP behind the proxy and ignores spoofed X-Forwarded-For entries', async () => {
    const app = buildApp();
    const postFrom = (forwardedFor: string) =>
      post(validBody(), SHOP_ORIGIN, app).set('X-Forwarded-For', forwardedFor);

    for (let i = 0; i < SESSION_RATE_LIMIT_MAX; i++) {
      // A fresh fake address on the left each time: only the hop added by the proxy counts.
      const response = await postFrom(`10.0.0.${i}, 41.82.1.1`);
      expect(response.status).toBe(204);
    }
    expect(store.get('+221776986780')?.ip).toBe('41.82.1.1');

    expect((await postFrom('10.9.9.9, 41.82.1.1')).status).toBe(429);
    expect((await postFrom('41.82.2.2')).status).toBe(204);
  });

  it('lets the request through when Redis is unreachable', async () => {
    mockRedisState.failure = 'reject';

    const response = await post(validBody());

    expect(response.status).toBe(204);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts without counting while the client connects, then counts once it is ready', async () => {
    mockRedisState.initialStatus = 'connecting';
    const app = buildApp();

    for (let i = 0; i < 5; i++) {
      const response = await post(validBody(), SHOP_ORIGIN, app);
      expect(response.status).toBe(204);
    }

    expect(mockRedisState.instances).toHaveLength(1);
    expect(mockRedisState.instances[0]?.execCalls).toBe(0);
    expect(mockRedisState.instances[0]?.disconnected).toBe(false);

    mockRedisState.instances[0]!.status = 'ready';

    for (let i = 0; i < SESSION_RATE_LIMIT_MAX; i++) {
      const response = await post(validBody(), SHOP_ORIGIN, app);
      expect(response.status).toBe(204);
    }

    const limited = await post(validBody(), SHOP_ORIGIN, app);

    expect(limited.status).toBe(429);
    expect(mockRedisState.instances).toHaveLength(1);
    expect(mockRedisState.instances[0]?.execCalls).toBe(SESSION_RATE_LIMIT_MAX + 1);
  });

  it('does not reset the client on a connection error and counts as soon as it is ready', async () => {
    mockRedisState.initialStatus = 'connecting';
    const app = buildApp();

    expect((await post(validBody(), SHOP_ORIGIN, app)).status).toBe(204);
    const client = mockRedisState.instances[0]!;
    client.status = 'reconnecting';
    client.emit('error', new Error('connect ECONNREFUSED'));

    for (let i = 0; i < 5; i++) {
      const response = await post(validBody(), SHOP_ORIGIN, app);
      expect(response.status).toBe(204);
    }

    expect(mockRedisState.instances).toHaveLength(1);
    expect(client.disconnected).toBe(false);
    expect(client.execCalls).toBe(0);

    // No bypass was started: the very next request on the ready client is counted.
    client.status = 'ready';
    expect((await post(validBody(), SHOP_ORIGIN, app)).status).toBe(204);
    expect(client.execCalls).toBe(1);
    expect(mockRedisState.instances).toHaveLength(1);
  });

  it('does not pile up timed-out commands on a mute Redis and retries with a fresh client later', async () => {
    mockRedisState.failure = 'timeout';
    const app = buildApp();

    for (let i = 0; i < 40; i++) {
      const response = await post(validBody(), SHOP_ORIGIN, app);
      expect(response.status).toBe(204);
    }

    // One command timed out, the client was dropped (queue flushed), the limiter is skipped.
    const pending = mockRedisState.instances.reduce((total, client) => total + client.commandQueue.length, 0);
    expect(pending).toBe(0);
    expect(mockRedisState.instances).toHaveLength(1);
    expect(mockRedisState.instances[0]?.disconnected).toBe(true);
    expect(mockRedisState.instances[0]?.execCalls).toBe(1);
    expect(upsertSpy).toHaveBeenCalledTimes(40);

    // After the bypass period, a new client is created on demand.
    mockRedisState.failure = null;
    clock += SESSION_RATE_LIMIT_BYPASS_MS;
    const response = await post(validBody(), SHOP_ORIGIN, app);

    expect(response.status).toBe(204);
    expect(mockRedisState.instances).toHaveLength(2);
    expect(mockRedisState.instances[1]?.execCalls).toBe(1);
  });

  it('lets the request through when the Redis command fails', async () => {
    mockRedisState.failure = 'incrError';

    const response = await post(validBody());

    expect(response.status).toBe(204);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
  });
});
