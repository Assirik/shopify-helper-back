import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../utilities/logger/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() }
}));

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
});
