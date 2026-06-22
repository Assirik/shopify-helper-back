import { describe, expect, it, jest } from '@jest/globals';
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import config from '../utilities/config/env.config';
import { requireAuth } from './requireAuth';

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
};

describe('requireAuth', () => {
  it('accepts an active user with the current session version', async () => {
    const select = jest.fn<() => Promise<{ isActive: boolean; sessionVersion: number }>>().mockResolvedValue({
      isActive: true,
      sessionVersion: 3
    });
    jest.spyOn(User, 'findById').mockReturnValue({ select } as never);
    const token = jwt.sign({ userId: 'user-id', sessionVersion: 3 }, config.jwtSecret);
    const request = { headers: { authorization: `Bearer ${token}` } } as Request;
    const { response } = createResponse();
    const next = jest.fn() as NextFunction;

    await requireAuth(request, response, next);

    expect(request.userId).toBe('user-id');
    expect(request.user).toEqual({ isActive: true, sessionVersion: 3 });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects a token revoked by a session version change', async () => {
    const select = jest.fn<() => Promise<{ isActive: boolean; sessionVersion: number }>>().mockResolvedValue({
      isActive: true,
      sessionVersion: 4
    });
    jest.spyOn(User, 'findById').mockReturnValue({ select } as never);
    const token = jwt.sign({ userId: 'user-id', sessionVersion: 3 }, config.jwtSecret);
    const request = { headers: { authorization: `Bearer ${token}` } } as Request;
    const { response, status, json } = createResponse();

    await requireAuth(request, response, jest.fn() as NextFunction);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'InvalidToken' });
  });
});
