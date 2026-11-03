import { describe, expect, it, jest } from '@jest/globals';
import * as Sentry from '@sentry/node';
import { captureApiError, captureJobFailure, flushSentry, initSentry } from './sentry';
import { sanitizeEvent } from './scrub';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  isEnabled: jest.fn(() => false),
  flush: jest.fn(),
  withScope: jest.fn(),
  captureException: jest.fn(),
  expressIntegration: jest.fn(() => ({ name: 'Express' })),
  onUnhandledRejectionIntegration: jest.fn(() => ({ name: 'OnUnhandledRejection' }))
}));

describe('initSentry', () => {
  it.each([undefined, '', '   ', 'not-a-dsn'])('does not call Sentry.init without a usable DSN (%p)', dsn => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(initSentry({ SENTRY_DSN: dsn } as NodeJS.ProcessEnv)).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('initialises with privacy-first options when a DSN is set', () => {
    jest.mocked(Sentry.isEnabled).mockReturnValueOnce(true);
    const ok = initSentry({
      SENTRY_DSN: 'http://key@127.0.0.1:9/2',
      NODE_ENV: 'production',
      SENTRY_RELEASE: ' v1 '
    } as NodeJS.ProcessEnv);

    expect(ok).toBe(true);
    const options = jest.mocked(Sentry.init).mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({
      dsn: 'http://key@127.0.0.1:9/2',
      environment: 'production',
      release: 'v1',
      tracePropagationTargets: [],
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false }
    });
    expect(options.beforeSend).toBe(sanitizeEvent);
    // Any tracesSampleRate (even 0) would switch tracing on in v11.
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(Sentry.expressIntegration).toHaveBeenCalledWith({ shouldHandleError: expect.any(Function) });
    expect(Sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: 'strict' });
  });
});

describe('helpers when Sentry is not enabled', () => {
  it('capture helpers and flush do nothing', async () => {
    captureJobFailure('q', { id: '1', attemptsMade: 3, opts: { attempts: 3 } }, new Error('x'));
    captureApiError(new Error('x'), 'req-1');
    await flushSentry();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.withScope).not.toHaveBeenCalled();
    expect(Sentry.flush).not.toHaveBeenCalled();
  });
});
