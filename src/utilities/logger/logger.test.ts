import { describe, expect, it, jest, afterEach } from '@jest/globals';

// The real env.config calls dotenv: a developer's local .env must never reach these tests.
jest.mock('../config/env.config', () => ({ __esModule: true, default: {} }));

const originalEnv = process.env.NODE_ENV;
const originalJestWorker = process.env.JEST_WORKER_ID;
const originalAxiom = {
  token: process.env.AXIOM_TOKEN,
  dataset: process.env.AXIOM_DATASET,
  url: process.env.AXIOM_URL
};

const setEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const setAxiomEnv = (token: string | undefined, dataset: string | undefined, url?: string) => {
  setEnv('AXIOM_TOKEN', token);
  setEnv('AXIOM_DATASET', dataset);
  setEnv('AXIOM_URL', url);
};

interface Loaded {
  options: any;
  destination: any;
  transports: any[];
  streams: any[];
}
let lastLoad: Loaded;

// `underJest: false` hides JEST_WORKER_ID, to exercise the code paths that are disabled under Jest.
const loadWithMockedPino = (
  nodeEnv: string | undefined,
  axiom: [string | undefined, string | undefined, string?] = [undefined, undefined],
  underJest = true
) => {
  setAxiomEnv(...axiom);
  setEnv('NODE_ENV', nodeEnv);
  if (!underJest) delete process.env.JEST_WORKER_ID;
  const load: Loaded = { options: undefined, destination: undefined, transports: [], streams: [] };
  jest.resetModules();
  jest.doMock('pino', () => {
    const fn: any = (opts: any, destination?: any) => {
      load.options = opts;
      load.destination = destination;
      return {};
    };
    fn.stdSerializers = { err: () => ({}) };
    fn.stdTimeFunctions = { isoTime: () => ',"time":"x"' };
    fn.symbols = {};
    fn.destination = (fd: number) => ({ kind: 'destination', fd });
    fn.multistream = (streams: any[]) => {
      load.streams = streams;
      return { kind: 'multistream', streams };
    };
    fn.transport = (opts: any) => {
      const stream = { kind: 'transport', opts, on: jest.fn() };
      load.transports.push(stream);
      return stream;
    };
    return { __esModule: true, default: fn };
  });
  jest.isolateModules(() => {
    require('./logger');
  });
  lastLoad = load;
  return load.options;
};

afterEach(() => {
  setEnv('NODE_ENV', originalEnv);
  setEnv('JEST_WORKER_ID', originalJestWorker);
  setAxiomEnv(originalAxiom.token, originalAxiom.dataset, originalAxiom.url);
  jest.dontMock('pino');
  jest.resetModules();
});

describe('logger', () => {
  it('uses no pino-pretty transport in production', () => {
    const options = loadWithMockedPino('production');
    expect(options.transport).toBeUndefined();
    expect(options.base).not.toHaveProperty('pid');
    expect(options.timestamp).toBeDefined();
    expect(lastLoad.destination).toBeUndefined();
  });

  it('keeps pino-pretty outside production', () => {
    expect(loadWithMockedPino(undefined).transport.target).toBe('pino-pretty');
    expect(loadWithMockedPino('development').transport.target).toBe('pino-pretty');
  });

  it('puts service and env on every line, without pid and hostname', () => {
    expect(loadWithMockedPino('production').base).toEqual({ service: 'ecom-helper-back', env: 'production' });
    expect(loadWithMockedPino('staging').base).toEqual({ service: 'ecom-helper-back', env: 'staging' });
  });

  it.each([
    [undefined, undefined],
    ['tok', undefined],
    [undefined, 'ds'],
    ['', 'ds'],
    ['tok', '  ']
  ])('has no Axiom stream when AXIOM_TOKEN=%p and AXIOM_DATASET=%p', (token, dataset) => {
    expect(loadWithMockedPino('production', [token, dataset], false).transport).toBeUndefined();
    expect(lastLoad.destination).toBeUndefined();
    expect(lastLoad.transports).toHaveLength(0);
    expect(loadWithMockedPino('development', [token, dataset], false).transport.target).toBe('pino-pretty');
    expect(lastLoad.destination).toBeUndefined();
  });

  it('never uses Axiom under Jest or NODE_ENV=test, even when AXIOM_* is set (local .env)', () => {
    loadWithMockedPino('production', ['tok', 'ds'], true);
    expect(lastLoad.destination).toBeUndefined();
    expect(lastLoad.transports).toHaveLength(0);
    loadWithMockedPino('test', ['tok', 'ds'], false);
    expect(lastLoad.destination).toBeUndefined();
    expect(lastLoad.transports).toHaveLength(0);
  });

  it('in production: stdout stays a synchronous destination of the main thread, Axiom is a separate stream', () => {
    const options = loadWithMockedPino('production', ['tok', 'ecom-helper'], false);
    expect(options.transport).toBeUndefined();
    expect(lastLoad.destination.kind).toBe('multistream');
    expect(lastLoad.streams).toHaveLength(2);
    expect(lastLoad.streams[0].stream).toEqual({ kind: 'destination', fd: 1 });
    const axiom = lastLoad.streams[1].stream;
    expect(axiom.opts.target).toMatch(/axiomTransport\.(ts|js)$/);
    expect(axiom.opts.options).toEqual({ dataset: 'ecom-helper', token: 'tok' });
    expect(lastLoad.transports).toHaveLength(1);
  });

  it('passes AXIOM_URL to the transport when set', () => {
    loadWithMockedPino('production', ['tok', 'ds', 'http://127.0.0.1:9'], false);
    expect(lastLoad.streams[1].stream.opts.options).toEqual({ dataset: 'ds', token: 'tok', url: 'http://127.0.0.1:9' });
  });

  it.each([
    ['https://us-east-1.aws.edge.axiom.co/', 'https://us-east-1.aws.edge.axiom.co'],
    ['https://eu.example.axiom.co///', 'https://eu.example.axiom.co'],
    ['http://127.0.0.1:4010/', 'http://127.0.0.1:4010'],
    ['http://localhost:4010', 'http://localhost:4010']
  ])('accepts AXIOM_URL=%s (normalised to %s)', (raw, expected) => {
    loadWithMockedPino('production', ['tok', 'ds', raw], false);
    expect(lastLoad.streams[1].stream.opts.options.url).toBe(expected);
  });

  it.each([['http://api.axiom.co'], ['ftp://x.example'], ['https://user:pass@x.example'], ['not a url'], ['http://127.0.0.1.evil.example']])(
    'refuses AXIOM_URL=%s: Axiom disabled, one notice on stderr without the URL or the token',
    raw => {
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        loadWithMockedPino('production', ['SECRET-TOKEN', 'ds', raw], false);
        expect(lastLoad.destination).toBeUndefined();
        expect(lastLoad.transports).toHaveLength(0);
        const notice = write.mock.calls.map(c => String(c[0])).join('');
        expect(notice).toContain('AXIOM_URL ignored');
        expect(notice).not.toContain('SECRET-TOKEN');
        expect(notice).not.toContain(raw);
      } finally {
        write.mockRestore();
      }
    }
  );

  it('uses the transport default URL when AXIOM_URL is empty', () => {
    loadWithMockedPino('production', ['tok', 'ds', '  '], false);
    expect(lastLoad.streams[1].stream.opts.options).toEqual({ dataset: 'ds', token: 'tok' });
  });

  it('in development: pino-pretty and Axiom are two separate streams', () => {
    loadWithMockedPino('development', ['tok', 'ds'], false);
    expect(lastLoad.streams).toHaveLength(2);
    expect(lastLoad.streams[0].stream.opts.target).toBe('pino-pretty');
    expect(lastLoad.streams[1].stream.opts.target).toMatch(/axiomTransport\.(ts|js)$/);
  });

  it('keeps redact, serializers and timestamp in the options when Axiom is on (applied before any destination)', () => {
    const options = loadWithMockedPino('production', ['tok', 'ds'], false);
    expect(options.redact.paths).toContain('req.headers.authorization');
    expect(options.serializers.err).toEqual(expect.any(Function));
    expect(options.timestamp).toBeDefined();
    expect(options.formatters).toBeUndefined();
  });

  it('a dying Axiom stream writes one notice on stderr, with the token redacted, and does not throw', () => {
    loadWithMockedPino('production', ['SECRET-TOKEN', 'ds'], false);
    const axiom = lastLoad.streams[1].stream;
    const onError = axiom.on.mock.calls.find((c: any[]) => c[0] === 'error')![1];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => {
        onError(new Error('worker died with SECRET-TOKEN'));
        onError(new Error('again'));
      }).not.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]![0])).toContain('worker died with [Redacted]');
      expect(String(write.mock.calls[0]![0])).not.toContain('SECRET-TOKEN');
    } finally {
      write.mockRestore();
    }
  });
});

// `lib` has no ES2022 Error options: attach the cause by hand.
const withCause = (message: string, cause: unknown): any => Object.assign(new Error(message), { cause });

const logError = async (err: unknown, extra: Record<string, unknown> = {}) => {
  jest.resetModules();
  process.env.NODE_ENV = 'production';
  setAxiomEnv(undefined, undefined);
  const chunks: string[] = [];
  const pino = (await import('pino')).default;
  const { loggerOptions } = await import('./logger');
  pino(loggerOptions, { write: (c: string) => void chunks.push(c) } as any).error({ err, ...extra }, 'boom');
  const out = chunks.join('');
  return { out, parsed: JSON.parse(out) };
};

describe('logger err serializer: personal data', () => {
  it('writes service and env, and no pid/hostname', async () => {
    const { parsed } = await logError(new Error('x'));
    expect(parsed.service).toBe('ecom-helper-back');
    expect(parsed.env).toBe('production');
    expect(parsed).not.toHaveProperty('pid');
    expect(parsed).not.toHaveProperty('hostname');
  });

  it('reduces a MongoDB E11000 on phoneE164 to type, code and index name', async () => {
    const { MongoServerError } = await import('mongodb');
    const err = new MongoServerError({
      message: 'E11000 duplicate key error collection: shop.browsersessions index: phoneE164_1 dup key: { phoneE164: "+221776986780" }',
      code: 11000,
      keyPattern: { phoneE164: 1 },
      keyValue: { phoneE164: '+221776986780' }
    });
    (err as any).errorResponse = { errmsg: 'dup key: { phoneE164: "+221776986780" }' };
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('776986780');
    expect(parsed.err).toEqual({
      type: 'MongoServerError',
      code: 11000,
      message: 'E11000 duplicate key error collection: shop.browsersessions index: phoneE164_1',
      stack: expect.any(String)
    });
  });

  it('reduces a Mongoose ValidationError to paths and kinds', async () => {
    const mongoose = (await import('mongoose')).default;
    const model = mongoose.model('LogSerializerProbe', new mongoose.Schema({ phone: { type: String, minlength: 30 }, qty: Number }));
    const err = await new model({ phone: '+221776986780', qty: 'REJECTEDQTY' }).validate().catch((e: unknown) => e);
    expect((err as Error).message).toContain('776986780');
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('776986780');
    expect(out).not.toContain('REJECTEDQTY');
    expect(parsed.err.type).toBe('ValidationError');
    expect(parsed.err.message).toMatch(/^LogSerializerProbe validation failed: (phone, qty|qty, phone)$/);
    expect(parsed.err.errors.phone).toEqual({ name: 'ValidatorError', kind: 'minlength', path: 'phone' });
    expect(parsed.err.errors.qty.path).toBe('qty');
  });

  it('reduces a Mongoose CastError to path and kind', async () => {
    const mongoose = (await import('mongoose')).default;
    const err = new mongoose.Error.CastError('ObjectId', '+221776986780', '_id');
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('776986780');
    expect(parsed.err).toMatchObject({ type: 'CastError', kind: 'ObjectId', path: '_id', message: 'Cast to ObjectId failed at path "_id"' });
  });

  it('drops the body (and the quoted snippet) of a JSON parse error', async () => {
    let caught: any;
    try {
      JSON.parse('{"phone":"+221776986780",');
    } catch (e) {
      caught = e;
    }
    caught.body = '{"phone":"+221776986780",';
    caught.type = 'entity.parse.failed';
    caught.statusCode = 400;
    const { out, parsed } = await logError(caught);
    expect(out).not.toContain('776986780');
    expect(parsed.err).not.toHaveProperty('body');
    expect(parsed.err.message).toBe('Request body is not valid JSON');
    expect(parsed.err.statusCode).toBe(400);
  });

  it('always writes type AxiosError for an Axios error, whatever its name', async () => {
    const { AxiosError } = await import('axios');
    const err = new AxiosError('Network Error', 'ERR_NETWORK');
    err.name = 'Error';
    const { parsed } = await logError(err);
    expect(parsed.err.type).toBe('AxiosError');
    expect(parsed.err.code).toBe('ERR_NETWORK');
  });

  it('does not unwrap `raw` from a real Error', () => {
    const { serializeError } = require('./logger');
    const err: any = new Error('real');
    err.raw = new Error('other');
    expect(serializeError(err).message).toBe('real');
    expect(serializeError({ type: 'Error', message: 'flat', raw: new Error('inner') }).message).toBe('inner');
  });
});

describe('logger err serializer', () => {
  it('keeps secrets of an AxiosError out of the serialized error', async () => {
    const { AxiosError } = await import('axios');
    const err = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', {
      method: 'post',
      url: 'https://chatwoot.example/api/v1/x?access_token=URLSECRET&page=1',
      params: { access_token: 'PARAMSECRET' },
      data: '{"phone":"+221776986780"}',
      headers: { Authorization: 'Bearer AUTHSECRET', api_access_token: 'CWTOKEN', 'X-Hub-Signature-256': 'SIGSECRET' } as any
    } as any, { _header: 'Authorization: REQHEADERSECRET' }, {
      status: 401,
      data: { echoed: 'RESPBODYSECRET' },
      headers: {},
      statusText: 'x',
      config: {} as any
    } as any);

    jest.resetModules();
    process.env.NODE_ENV = 'production';
    const chunks: string[] = [];
    const pino = (await import('pino')).default;
    const { loggerOptions } = await import('./logger');
    const log = pino(loggerOptions, { write: (c: string) => void chunks.push(c) } as any);
    log.error({ err }, 'boom');

    const out = chunks.join('');
    for (const secret of ['URLSECRET', 'PARAMSECRET', '776986780', 'AUTHSECRET', 'CWTOKEN', 'SIGSECRET', 'REQHEADERSECRET', 'RESPBODYSECRET']) {
      expect(out).not.toContain(secret);
    }
    const parsed = JSON.parse(out);
    expect(parsed.err.code).toBe('ERR_BAD_REQUEST');
    expect(parsed.err.config).toEqual({ method: 'post', url: 'https://chatwoot.example/api/v1/x?access_token=[Redacted]&page=1' });
    expect(parsed.err.response).toEqual({ status: 401 });
  });

  it('serializes ordinary errors with the standard serializer', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    const chunks: string[] = [];
    const pino = (await import('pino')).default;
    const { loggerOptions } = await import('./logger');
    pino(loggerOptions, { write: (c: string) => void chunks.push(c) } as any).error({ err: new Error('plain') }, 'x');
    expect(JSON.parse(chunks.join('')).err.message).toBe('plain');
  });

  it('keeps only the name of an ioredis command: the AUTH password never reaches the log', async () => {
    const err: any = new Error('WRONGPASS invalid username-password pair or user is disabled.');
    err.command = { name: 'auth', args: ['REDIS-PASSWORD'] };
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('REDIS-PASSWORD');
    expect(parsed.err.command).toEqual({ name: 'auth' });
    expect(parsed.err.message).toContain('WRONGPASS');
  });

  it('filters the cause of an error through the same rules (E11000 in cause: message and stack)', async () => {
    const { MongoServerError } = await import('mongodb');
    const cause = new MongoServerError({
      message: 'E11000 duplicate key error collection: shop.users index: phone_1 dup key: { phone: "+221776986780" }',
      code: 11000,
      keyValue: { phone: '+221776986780' }
    });
    const err = withCause('Could not create the user', cause);
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('776986780');
    expect(parsed.err.message).toBe('Could not create the user');
    expect(parsed.err.cause).toEqual({
      type: 'MongoServerError',
      code: 11000,
      message: 'E11000 duplicate key error collection: shop.users index: phone_1',
      stack: expect.any(String)
    });
  });

  it('filters errors held in properties, AggregateError members and nested causes', async () => {
    const { AxiosError } = await import('axios');
    const axios = new AxiosError('x', 'ERR_BAD_REQUEST', { url: 'https://h.example/a?access_token=NESTEDSECRET', method: 'get' } as any);
    const err: any = Object.assign(withCause('several failures', withCause('mid', axios)), {
      name: 'AggregateError',
      errors: [axios, new Error('plain')]
    });
    err.lastError = axios;
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('NESTEDSECRET');
    expect(parsed.err.aggregateErrors[0].type).toBe('AxiosError');
    expect(parsed.err.aggregateErrors[1].message).toBe('plain');
    expect(parsed.err.errors[0].type).toBe('AxiosError');
    expect(parsed.err.lastError.type).toBe('AxiosError');
    expect(parsed.err.cause.cause.type).toBe('AxiosError');
  });

  it('removes errInfo, errorResponse and key data from other MongoDB driver errors (code 121)', async () => {
    const { MongoServerError } = await import('mongodb');
    const err = new MongoServerError({
      message: 'Document failed validation',
      code: 121,
      errInfo: { details: { operatorName: '$jsonSchema', offending: 'PERSONAL-VALUE' } },
      errorResponse: { errInfo: 'PERSONAL-VALUE' }
    });
    const { out, parsed } = await logError(err);
    expect(out).not.toContain('PERSONAL-VALUE');
    expect(parsed.err.code).toBe(121);
    expect(parsed.err.message).toBe('Document failed validation');
  });

  it('reduces a Mongoose ValidatorError on its own', async () => {
    const mongoose = (await import('mongoose')).default;
    const model = mongoose.model('LogSerializerProbe2', new mongoose.Schema({ phone: { type: String, minlength: 30 } }));
    const validation: any = await new model({ phone: '+221776986780' }).validate().catch((e: unknown) => e);
    const validator = validation.errors.phone;
    expect(validator.name).toBe('ValidatorError');
    const { out, parsed } = await logError(validator);
    expect(out).not.toContain('776986780');
    expect(parsed.err).toMatchObject({ type: 'ValidatorError', kind: 'minlength', path: 'phone' });
  });
});
