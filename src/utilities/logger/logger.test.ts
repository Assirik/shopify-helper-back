import { describe, expect, it, jest, afterEach } from '@jest/globals';

const originalEnv = process.env.NODE_ENV;

const loadWithMockedPino = (nodeEnv: string | undefined) => {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  let options: any;
  jest.resetModules();
  jest.doMock('pino', () => {
    const fn: any = (opts: any) => {
      options = opts;
      return {};
    };
    fn.stdSerializers = { err: () => ({}) };
    fn.stdTimeFunctions = { isoTime: () => ',"time":"x"' };
    return { __esModule: true, default: fn };
  });
  jest.isolateModules(() => {
    require('./logger');
  });
  return options;
};

afterEach(() => {
  if (originalEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv;
  jest.dontMock('pino');
  jest.resetModules();
});

describe('logger', () => {
  it('uses no pino-pretty transport in production', () => {
    const options = loadWithMockedPino('production');
    expect(options.transport).toBeUndefined();
    expect(options.base).toBeUndefined();
    expect(options.timestamp).toBeDefined();
  });

  it('keeps pino-pretty outside production', () => {
    expect(loadWithMockedPino(undefined).transport.target).toBe('pino-pretty');
    expect(loadWithMockedPino('development').transport.target).toBe('pino-pretty');
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
});
