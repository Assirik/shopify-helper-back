import { describe, expect, it, jest } from '@jest/globals';

// The real routes open database and queue connections; only the app settings matter here.
jest.mock('./routes/routes', () => jest.requireActual<typeof import('express')>('express').Router());

import app from './app';

describe('app', () => {
  it('trusts exactly one proxy hop (same setting as buildApp in browserSession.controller.test.ts)', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});
