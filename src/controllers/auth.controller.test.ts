import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { AuthController, isValidSignupPassword } from './auth.controller';

describe('authentication validation', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['1234567', false],
    ['12345678', true],
    ['a'.repeat(73), false]
  ])('validates password %p as %p', (password, expected) => {
    expect(isValidSignupPassword(password)).toBe(expected);
  });

  it('rejects invalid user data before persistence', async () => {
    const app = express();
    app.use(express.json());
    app.post('/users', AuthController.createUser);

    const response = await request(app).post('/users').send({
      userName: 'x',
      email: 'invalid',
      password: 'short',
      role: 'UNKNOWN'
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ValidationFailed');
    expect(response.body.details).toEqual(expect.objectContaining({ userName: expect.any(String), email: expect.any(String), password: expect.any(String), role: expect.any(String) }));
  });

  it('rejects a caller-provided bootstrap role before persistence', async () => {
    const app = express();
    app.use(express.json());
    app.post('/bootstrap', AuthController.bootstrapAdmin);

    const response = await request(app).post('/bootstrap').send({
      userName: 'initial.admin',
      email: 'admin@example.com',
      password: '12345678',
      role: 'USER'
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'ValidationFailed',
      details: { role: 'Role is forced to ADMIN and must not be provided' }
    });
  });

  it('prevents an administrator from disabling their own account', async () => {
    const app = express();
    app.use(express.json());
    app.patch(
      '/users/:userId/status',
      (req, _res, next) => {
        req.userId = typeof req.params.userId === 'string' ? req.params.userId : undefined;
        next();
      },
      AuthController.setUserStatus
    );

    const response = await request(app).patch('/users/6650f1d7a7b3c42f842b1234/status').send({ isActive: false });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'CannotDisableOwnAccount' });
  });
});
