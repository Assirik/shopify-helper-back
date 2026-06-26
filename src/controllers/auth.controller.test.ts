import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { AuthController, isValidSignupPassword } from './auth.controller';

describe('signup password validation', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['1234567', false],
    ['12345678', true]
  ])('validates %p as %p', (password, expected) => {
    expect(isValidSignupPassword(password)).toBe(expected);
  });

  it('rejects a short password before touching persistence', async () => {
    const app = express();
    app.use(express.json());
    app.post('/signup', AuthController.signup);

    const response = await request(app).post('/signup').send({
      userName: 'helpdesk.agent',
      email: 'agent@example.com',
      password: 'short'
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'InvalidPassword' });
  });
});
