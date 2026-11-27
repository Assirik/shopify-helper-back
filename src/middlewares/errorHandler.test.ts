import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() }
}));
import log from '../utilities/logger/logger';

import express from 'express';
import request from 'supertest';
import { asyncHandler } from './asyncHandler';
import { errorHandler } from './errorHandler';

describe('errorHandler', () => {
  it('returns a stable JSON error for unhandled async failures', async () => {
    const app = express();
    app.get(
      '/failure',
      asyncHandler(async () => {
        throw new Error('database unavailable');
      })
    );
    app.use(errorHandler);

    const response = await request(app).get('/failure');

    expect(response.status).toBe(500);
    expect(response.type).toBe('application/json');
    expect(response.body).toEqual({ error: 'InternalError' });
  });

  it('masks personal data and secrets in the logged path', async () => {
    const app = express();
    app.get('/failure', () => {
      throw new Error('x');
    });
    app.use(errorHandler);

    await request(app).get('/failure?phone=%2B221776986780&page=2');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/failure?phone=[Redacted]&page=2', method: 'GET' }),
      'Unhandled API error'
    );
  });

  it('logs through req.log when available', async () => {
    const reqLog = { error: jest.fn() };
    const app = express();
    app.use((req, _res, next) => {
      (req as any).log = reqLog;
      next();
    });
    app.get('/failure', () => {
      throw new Error('x');
    });
    app.use(errorHandler);

    await request(app).get('/failure');

    expect(reqLog.error).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET' }), 'Unhandled API error');
  });
});
