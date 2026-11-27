import { afterEach, describe, expect, it, jest } from '@jest/globals';
import http from 'http';
import { AddressInfo } from 'net';
import { AxiomShipper, mapLevel, toAxiomEvent } from './axiomTransport';

// A fake Axiom ingest API on an ephemeral local port. Nothing here talks to the real service.
type Mode = 'ok' | '503' | '401' | '430' | 'hang' | 'partial';
interface FakeAxiom {
  url: string;
  setMode: (mode: Mode) => void;
  requests: Array<{ path: string; auth?: string; contentType?: string; events: Record<string, any>[] }>;
  maxConcurrent: () => number;
  stop: () => Promise<void>;
}

const startFakeAxiom = async (initial: Mode = 'ok'): Promise<FakeAxiom> => {
  let mode: Mode = initial;
  let concurrent = 0;
  let maxConcurrent = 0;
  const requests: FakeAxiom['requests'] = [];
  const sockets = new Set<import('net').Socket>();
  const server = http.createServer((req, res) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    res.on('close', () => concurrent--);
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const events = Buffer.concat(chunks).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
      requests.push({ path: req.url ?? '', auth: req.headers.authorization, contentType: req.headers['content-type'], events });
      if (mode === 'hang') return;
      const status = mode === '503' ? 503 : mode === '401' ? 401 : mode === '430' ? 430 : 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        mode === 'partial'
          ? JSON.stringify({ ingested: events.length - 2, failed: 2, failures: [{ timestamp: 't', error: 'PRIVATE-EVENT-CONTENT' }] })
          : JSON.stringify({ ingested: events.length, failed: 0, failures: [] })
      );
    });
  });
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setMode: m => {
      mode = m;
    },
    requests,
    maxConcurrent: () => maxConcurrent,
    stop: () =>
      new Promise<void>(resolve => {
        sockets.forEach(s => s.destroy());
        server.close(() => resolve());
      })
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

let fake: FakeAxiom | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

const shipper = (options: Partial<ConstructorParameters<typeof AxiomShipper>[0]> = {}) => {
  const reports: string[] = [];
  const instance = new AxiomShipper({
    dataset: 'ecom-helper',
    token: 'SECRET-TOKEN',
    url: fake!.url,
    flushIntervalMs: 20,
    requestTimeoutMs: 300,
    closeTimeoutMs: 400,
    report: m => reports.push(m),
    ...options
  });
  return { instance, reports };
};

describe('toAxiomEvent', () => {
  it('maps pino levels to names and time to _time', () => {
    expect(mapLevel(30)).toBe('info');
    expect(mapLevel(50)).toBe('error');
    expect(mapLevel('warn')).toBe('warn');
    expect(toAxiomEvent({ level: 40, time: 't', msg: 'm', a: 1 })).toEqual({ _time: 't', level: 'warn', msg: 'm', a: 1 });
  });
});

describe('AxiomShipper against a fake Axiom', () => {
  it('ships pino lines (after redact and serializers) with service and env, and no personal data', async () => {
    fake = await startFakeAxiom('ok');
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    const pino = (await import('pino')).default;
    const { loggerOptions } = await import('./logger');
    const { MongoServerError } = await import('mongodb');
    const { instance } = shipper();
    const log = pino(loggerOptions, { write: (chunk: string) => instance.enqueue(toAxiomEvent(JSON.parse(chunk))) } as any);

    log.info({ req: { headers: { authorization: 'Bearer JWT-SECRET' } } }, 'with a header');
    log.error(
      {
        err: new MongoServerError({
          message: 'E11000 duplicate key error collection: s.browsersessions index: phoneE164_1 dup key: { phoneE164: "+221776986780" }',
          code: 11000,
          keyValue: { phoneE164: '+221776986780' }
        })
      },
      'duplicate'
    );
    await waitFor(() => fake!.requests.length > 0);
    await instance.close();

    const received = fake.requests.flatMap(r => r.events);
    expect(received).toHaveLength(2);
    expect(fake.requests[0]!.path).toBe('/v1/ingest/ecom-helper');
    expect(fake.requests[0]!.auth).toBe('Bearer SECRET-TOKEN');
    expect(fake.requests[0]!.contentType).toBe('application/x-ndjson');
    const raw = JSON.stringify(received);
    expect(raw).not.toContain('JWT-SECRET');
    expect(raw).not.toContain('776986780');
    for (const event of received) {
      expect(event).toMatchObject({ service: 'ecom-helper-back', env: 'production' });
      expect(event._time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(event).not.toHaveProperty('pid');
      expect(event).not.toHaveProperty('hostname');
    }
    expect(received[0]!.level).toBe('info');
    expect(received[1]!.err.message).toBe('E11000 duplicate key error collection: s.browsersessions index: phoneE164_1');
  });

  it('sends in batches of at most maxBatch, one request at a time', async () => {
    fake = await startFakeAxiom('ok');
    const { instance } = shipper({ maxBatch: 10, maxQueue: 1000 });
    for (let i = 0; i < 95; i++) instance.enqueue({ i });
    await waitFor(() => fake!.requests.reduce((n, r) => n + r.events.length, 0) === 95);
    expect(Math.max(...fake.requests.map(r => r.events.length))).toBeLessThanOrEqual(10);
    expect(fake.maxConcurrent()).toBe(1);
    expect(fake.requests.flatMap(r => r.events.map(e => e.i))).toEqual(Array.from({ length: 95 }, (_, i) => i));
    await instance.close();
  });

  it('keeps memory bounded while Axiom answers 503: the queue never exceeds the cap and drops are counted', async () => {
    fake = await startFakeAxiom('503');
    const { instance, reports } = shipper({ maxQueue: 50, maxBatch: 20, reportIntervalMs: 0 });
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 100; i++) instance.enqueue({ round, i });
      expect(instance.queued).toBeLessThanOrEqual(50 + 20); // cap + one retried batch
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(instance.totalDropped).toBeGreaterThan(1500);
    expect(reports.some(r => /dropped/.test(r) && /HTTP 503/.test(r))).toBe(true);
    expect(reports.join('')).not.toContain('SECRET-TOKEN');
    await instance.close();
  });

  it('recovers and delivers the retained events once Axiom is back', async () => {
    fake = await startFakeAxiom('503');
    const { instance } = shipper({ maxQueue: 100 });
    for (let i = 0; i < 10; i++) instance.enqueue({ i });
    await waitFor(() => fake!.requests.length >= 1);
    fake.setMode('ok');
    await waitFor(() => fake!.requests.some((r, idx) => idx > 0 && r.events.length === 10), 5000);
    await instance.close();
  });

  it('with a hanging Axiom: one request in flight, a short timeout, memory bounded, close() returns within its limit', async () => {
    fake = await startFakeAxiom('hang');
    const { instance } = shipper({ maxQueue: 30, maxBatch: 10, requestTimeoutMs: 150, closeTimeoutMs: 300 });
    for (let i = 0; i < 500; i++) instance.enqueue({ i });
    expect(instance.queued).toBeLessThanOrEqual(30 + 10);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(fake.maxConcurrent()).toBe(1);
    for (let i = 0; i < 100; i++) instance.enqueue({ i });
    const started = Date.now();
    await instance.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(instance.totalDropped).toBeGreaterThan(400);
  });

  it('does not retry a refused batch (401), counts it, and never leaks the token in a notice', async () => {
    fake = await startFakeAxiom('401');
    const { instance, reports } = shipper({ reportIntervalMs: 0 });
    for (let i = 0; i < 5; i++) instance.enqueue({ i });
    await waitFor(() => reports.length > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fake.requests).toHaveLength(1);
    expect(instance.queued).toBe(0);
    expect(reports.join('\n')).toMatch(/abandoned/);
    expect(reports.join('\n')).not.toContain('SECRET-TOKEN');
    await instance.close();
  });

  it('never throws when Axiom is unreachable (closed port)', async () => {
    fake = await startFakeAxiom('ok');
    const closedUrl = fake.url;
    await fake.stop();
    const { instance, reports } = shipper({ url: closedUrl, reportIntervalMs: 0 });
    expect(() => {
      for (let i = 0; i < 10; i++) instance.enqueue({ i });
    }).not.toThrow();
    await waitFor(() => reports.length > 0);
    await expect(instance.close()).resolves.toBeUndefined();
    fake = undefined;
  });

  it('close() ships what is left to a healthy Axiom', async () => {
    fake = await startFakeAxiom('ok');
    const { instance } = shipper({ flushIntervalMs: 60_000 });
    for (let i = 0; i < 7; i++) instance.enqueue({ i });
    await instance.close();
    expect(fake.requests.flatMap(r => r.events)).toHaveLength(7);
  });

  it('counts the events Axiom refuses inside a 200 answer and reports them without any event content', async () => {
    fake = await startFakeAxiom('partial');
    const { instance, reports } = shipper({ reportIntervalMs: 0 });
    for (let i = 0; i < 5; i++) instance.enqueue({ i });
    await waitFor(() => reports.some(r => /refused by Axiom/.test(r)));
    expect(reports.join('\n')).toMatch(/2 event\(s\) refused by Axiom/);
    expect(reports.join('\n')).not.toContain('PRIVATE-EVENT-CONTENT');
    expect(instance.totalDropped).toBe(2);
    await instance.close();
  });

  it('drops a batch on 430 (organisation ingest limit) without retrying it', async () => {
    fake = await startFakeAxiom('430');
    const { instance, reports } = shipper({ reportIntervalMs: 0 });
    for (let i = 0; i < 5; i++) instance.enqueue({ i });
    await waitFor(() => reports.length > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(fake.requests).toHaveLength(1);
    expect(instance.totalDropped).toBe(5);
    expect(reports.join('\n')).toMatch(/HTTP 430/);
    await instance.close();
  });

  it('gives a batch maxAttempts tries after 5xx, then drops and counts it (no endless duplicates)', async () => {
    fake = await startFakeAxiom('503');
    const { instance, reports } = shipper({ maxAttempts: 3, flushIntervalMs: 10, reportIntervalMs: 0 });
    for (let i = 0; i < 4; i++) instance.enqueue({ i });
    await waitFor(() => instance.totalDropped === 4, 5000);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fake.requests).toHaveLength(3);
    expect(instance.queued).toBe(0);
    expect(reports.join('\n')).toMatch(/abandoned/);
    await instance.close();
  });

  it('keeps the log line time on a retried batch (the time is the line own, not the reception time)', async () => {
    fake = await startFakeAxiom('503');
    const { instance } = shipper({ flushIntervalMs: 10 });
    instance.enqueue(toAxiomEvent({ level: 30, time: '2026-11-03T10:00:00.000Z', msg: 'old line' }));
    await waitFor(() => fake!.requests.length >= 1);
    fake.setMode('ok');
    await waitFor(() => fake!.requests.length >= 2, 5000);
    expect(fake.requests.map(r => r.events[0]!._time)).toEqual(['2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z']);
    await instance.close();
  });

  it('sends a full batch at once instead of waiting for the flush timer', async () => {
    fake = await startFakeAxiom('ok');
    const { instance } = shipper({ maxBatch: 10, flushIntervalMs: 60_000 });
    for (let i = 0; i < 10; i++) instance.enqueue({ i });
    await waitFor(() => fake!.requests.length === 1, 1000);
    expect(fake.requests[0]!.events).toHaveLength(10);
    await instance.close();
  });

  it('does not send a full batch at once while backing off after a failure', async () => {
    fake = await startFakeAxiom('503');
    const { instance } = shipper({ maxBatch: 5, flushIntervalMs: 500, maxQueue: 100 });
    for (let i = 0; i < 5; i++) instance.enqueue({ i });
    await waitFor(() => fake!.requests.length === 1);
    for (let i = 0; i < 20; i++) instance.enqueue({ i });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(fake.requests).toHaveLength(1);
    await instance.close();
  });

  it('removes trailing slashes from the base URL', async () => {
    fake = await startFakeAxiom('ok');
    const { instance } = shipper({ url: `${fake.url}///`, flushIntervalMs: 10 });
    instance.enqueue({ i: 1 });
    await waitFor(() => fake!.requests.length === 1);
    expect(fake.requests[0]!.path).toBe('/v1/ingest/ecom-helper');
    await instance.close();
  });
});
