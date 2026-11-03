import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import * as Sentry from '@sentry/node';
import type { Event } from '@sentry/node';

// Built at runtime so the digits never appear in a source line that Sentry could attach as context.
const mockPhone = ['+221', '776986', '780'].join('');

jest.mock('../logger/logger', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pino = require('pino');
  return { __esModule: true, default: pino({ level: 'silent' }), serializeError: (e: unknown) => e };
});

// The real app (requestLogger, body parsers, errorHandler) with a stub router that fails in
// the ways real routes do.
jest.mock('../../routes/routes', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Router } = require('express');
  const router = Router();
  router.post('/client-error', (_req: unknown, res: any) => res.status(400).json({ error: 'BadRequest' }));
  router.post('/conflict', (_req: unknown, res: any) => res.status(409).json({ error: 'Conflict' }));
  router.post('/boom', () => {
    throw new Error('boom for ' + mockPhone);
  });
  router.post('/upstream-400', () => {
    // e.g. an AxiosError from Meta: a 4xx status that is still a 500 for our client.
    throw Object.assign(new Error('Request failed with status code 400'), { status: 400 });
  });
  router.post('/async-boom', async () => {
    throw new Error('async boom');
  });
  return { __esModule: true, default: router };
});

import app from '../../app';
import { captureJobFailure, initSentry } from './sentry';
import { sanitizeEvent } from './scrub';

// Real Sentry client with an in-memory transport: nothing leaves the process.
const sent: Event[] = [];

beforeAll(() => {
  initSentry({ SENTRY_DSN: 'http://key@127.0.0.1:9/2', NODE_ENV: 'test' } as NodeJS.ProcessEnv, {
    transport: () => ({ send: async () => ({}), flush: async () => true }),
    // Records the event after the project's sanitizer, instead of sending it.
    beforeSend: event => {
      sent.push(sanitizeEvent(event));
      return null;
    }
  });
});

afterAll(async () => {
  await Sentry.close();
});

beforeEach(() => {
  sent.length = 0;
});

describe('API error capture (real app, real errorHandler)', () => {
  it('captures nothing for responses sent by controllers (400, 409)', async () => {
    await request(app).post('/client-error').expect(400);
    await request(app).post('/conflict').expect(409);
    await Sentry.flush(1000);
    expect(sent).toHaveLength(0);
  });

  it('captures nothing for invalid JSON or an oversized body (client errors, still answered 500 by errorHandler)', async () => {
    await request(app).post('/boom').set('Content-Type', 'application/json').send('{bad json').expect(500);
    await request(app)
      .post('/boom')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 10) }))
      .expect(500);
    await Sentry.flush(1000);
    expect(sent).toHaveLength(0);
  });

  it('captures a thrown error once, with the request_id of the response, without body or secrets', async () => {
    const res = await request(app)
      .post('/boom?token=abc&page=1')
      .set('x-request-id', 'req-123')
      .set('Authorization', 'Bearer secret')
      .set('Cookie', 'sid=1')
      .send({ phone: mockPhone });

    expect(res.status).toBe(500);
    expect(res.headers['x-request-id']).toBe('req-123');
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
    const [event] = sent;
    expect(event.tags).toMatchObject({ request_id: 'req-123' });
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.url).not.toContain('abc');
    const leaks = JSON.stringify(event).match(/.{40}(776986780|Bearer secret|sid=1|token=abc).{20}/g);
    expect(leaks).toBeNull();
  });

  it('captures once an error carrying a 4xx status that ends as a 500', async () => {
    const res = await request(app).post('/upstream-400').expect(500);
    expect(res.body).toEqual({ error: 'InternalError' });
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
  });

  it('captures a rejected async handler once', async () => {
    await request(app).post('/async-boom').expect(500);
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
  });
});

describe('captureJobFailure', () => {

  const job = (attemptsMade: number, attempts = 3) =>
    ({ id: 'confirm-initial-1', attemptsMade, opts: { attempts }, data: { orderId: 'o1' } }) as any;

  it('ignores a failure that will be retried', async () => {
    captureJobFailure('notification', job(1), new Error('x'));
    captureJobFailure('notification', job(2), new Error('x'));
    await Sentry.flush(1000);
    expect(sent).toHaveLength(0);
  });

  it('captures the last attempt once, with queue/jobId/orderId tags', async () => {
    captureJobFailure('notification', job(3), new Error('final'));
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0].tags).toMatchObject({ queue: 'notification', jobId: 'confirm-initial-1', orderId: 'o1' });
  });

  it('captures an UnrecoverableError on the first attempt', async () => {
    const err = new Error('stop');
    err.name = 'UnrecoverableError';
    captureJobFailure('capi', job(1, 5), err);
    await Sentry.flush(1000);
    expect(sent).toHaveLength(1);
  });

  it('does nothing without a job', async () => {
    captureJobFailure('capi', undefined, new Error('x'));
    await Sentry.flush(1000);
    expect(sent).toHaveLength(0);
  });
});
