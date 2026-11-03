import { describe, expect, it, jest } from '@jest/globals';
import * as Sentry from '@sentry/node';
import { initSentry } from './sentry';

describe('initSentry with an invalid DSN (real Sentry)', () => {
  it.each(['not-a-dsn', 'https://@/', 'ftp://k@host/1', 'https://k@host/abc'])('does not throw and leaves Sentry disabled (%s)', dsn => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => initSentry({ SENTRY_DSN: dsn } as NodeJS.ProcessEnv)).not.toThrow();
    expect(Sentry.isEnabled()).toBe(false);
    spy.mockRestore();
  });
});
