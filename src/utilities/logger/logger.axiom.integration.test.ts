import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';

// Real logger.ts, real pino worker thread, real transport, fake Axiom on a local ephemeral port.
// The logger refuses Axiom under Jest, so the scenario runs in a child process (no JEST_WORKER_ID).
jest.setTimeout(60_000);

jest.mock('../config/env.config', () => ({ __esModule: true, default: {} }));

const REPO_ROOT = path.resolve(__dirname, '../../..');
const LOGGER = path.join(__dirname, 'logger.ts');

const tmpDirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise(resolve => { s.closeAllConnections?.(); s.close(resolve); });
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const fakeAxiom = async (hang: boolean) => {
  const events: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      events.push(...Buffer.concat(chunks).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)));
      if (hang) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { events, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const runChild = async (url: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-int-'));
  tmpDirs.push(dir);
  const script = path.join(dir, 'child.js');
  fs.writeFileSync(
    script,
    `const { default: log, closeLogger } = require(${JSON.stringify(LOGGER)});
for (let i = 0; i < 20; i++) log.info({ i }, 'line');
log.error({ err: Object.assign(new Error('WRONGPASS'), { command: { name: 'auth', args: ['REDIS-PASSWORD'] } }) }, 'redis');
const t = Date.now();
closeLogger(2000).then(() => { require('fs').writeSync(2, 'CLOSE_MS=' + (Date.now() - t) + '\\n'); process.exit(0); });
`
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    AXIOM_TOKEN: 'SECRET-TOKEN',
    AXIOM_DATASET: 'ecom-helper',
    AXIOM_URL: url,
    TS_NODE_TRANSPILE_ONLY: 'true'
  };
  return new Promise<{ stdout: string; stderr: string; code: number | null; closeMs: number }>(resolve => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register', script], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => resolve({ stdout, stderr, code, closeMs: Number(/CLOSE_MS=(\d+)/.exec(stderr)?.[1] ?? NaN) }));
  });
};

describe('logger with Axiom, real worker', () => {
  it('writes every line to stdout and ships them to Axiom; closeLogger flushes quickly', async () => {
    const axiom = await fakeAxiom(false);
    const res = await runChild(axiom.url);
    expect(res.code).toBe(0);
    const lines = res.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(lines).toHaveLength(21);
    expect(axiom.events).toHaveLength(21);
    expect(axiom.events[0]).toMatchObject({ service: 'ecom-helper-back', env: 'production', level: 'info', msg: 'line', i: 0 });
    expect(JSON.stringify(axiom.events)).not.toContain('REDIS-PASSWORD');
    expect(JSON.stringify(lines)).not.toContain('REDIS-PASSWORD');
    expect(res.closeMs).toBeLessThan(1500);
    expect(res.stderr).not.toContain('SECRET-TOKEN');
  });

  it('with a hanging Axiom, stdout is complete and closeLogger returns within about 2 s', async () => {
    const axiom = await fakeAxiom(true);
    const res = await runChild(axiom.url);
    expect(res.code).toBe(0);
    expect(res.stdout.split('\n').filter(Boolean)).toHaveLength(21);
    expect(res.closeMs).toBeLessThan(2500);
    expect(res.stderr).not.toContain('SECRET-TOKEN');
  });
});

describe('a dead Axiom worker', () => {
  it('does not stop the API nor stdout: lines keep flowing to the synchronous destination, one notice on stderr', async () => {
    jest.resetModules();
    const pino = (await import('pino')).default;
    const { guardAxiomStream } = await import('./logger');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-dead-'));
    tmpDirs.push(dir);
    const target = path.join(dir, 'dying-transport.js');
    fs.writeFileSync(target, `module.exports = async () => { throw new Error('transport crashed with SECRET-TOKEN'); };\n`);

    const stdoutLines: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled = jest.fn();
    process.on('uncaughtException', unhandled);
    process.on('unhandledRejection', unhandled);
    try {
      process.env.AXIOM_TOKEN = 'SECRET-TOKEN';
      const dying = guardAxiomStream(pino.transport({ target, options: {} }));
      const log = pino(
        {},
        pino.multistream([{ stream: { write: (c: string) => void stdoutLines.push(c) } as any }, { stream: dying }])
      );
      for (let i = 0; i < 50; i++) log.info({ i }, 'before the crash is noticed');
      await new Promise(resolve => setTimeout(resolve, 800));
      for (let i = 0; i < 50; i++) log.info({ i }, 'after the crash');
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(stdoutLines).toHaveLength(100);
      expect(unhandled).not.toHaveBeenCalled();
      const notices = stderr.mock.calls.map(c => String(c[0])).filter(m => m.includes('axiom-log-transport'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).not.toContain('SECRET-TOKEN');
    } finally {
      delete process.env.AXIOM_TOKEN;
      process.off('uncaughtException', unhandled);
      process.off('unhandledRejection', unhandled);
      stderr.mockRestore();
    }
  });
});
