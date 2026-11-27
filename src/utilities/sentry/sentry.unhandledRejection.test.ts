import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '../../..');

// Real process, real Sentry init (fake DSN, in-memory transport: nothing is sent).
const run = (dsn: string) =>
  spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      `const { initSentry } = require('./src/utilities/sentry/sentry');
       initSentry({ SENTRY_DSN: ${JSON.stringify(dsn)} }, { transport: () => ({ send: async () => ({}), flush: async () => true }) });
       Promise.reject(new Error('unhandled'));
       setTimeout(() => process.exit(0), 3000);`
    ],
    { cwd: root, encoding: 'utf8', timeout: 20000 }
  );

jest.setTimeout(30000);

describe('unhandled rejection', () => {
  it('still makes the process exit with code 1 when Sentry is enabled', () => {
    expect(run('http://key@127.0.0.1:9/2').status).toBe(1);
  });

  it('still makes the process exit with code 1 without a DSN', () => {
    expect(run('').status).toBe(1);
  });
});
