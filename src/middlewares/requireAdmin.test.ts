import { describe, expect, it, jest } from '@jest/globals';
import { NextFunction, Request, Response } from 'express';
import { Role, User } from '../models/User';
import { requireAdmin } from './requireAdmin';

const createResponse = () => {
  const json = jest.fn();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));

  return { response: { status } as unknown as Response, status, json };
};

describe('requireAdmin', () => {
  it('rejects a non-admin authenticated user', async () => {
    const select = jest.fn<() => Promise<{ role: Role; isActive: boolean }>>().mockResolvedValue({
      role: Role.USER,
      isActive: true
    });
    jest.spyOn(User, 'findById').mockReturnValue({ select } as never);
    const { response, status, json } = createResponse();
    const next = jest.fn() as NextFunction;

    await requireAdmin({ userId: 'user-id' } as Request, response, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'AdminRequired' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows an admin user', async () => {
    const admin = { role: Role.ADMIN, isActive: true };
    const select = jest.fn<() => Promise<typeof admin>>().mockResolvedValue(admin);
    jest.spyOn(User, 'findById').mockReturnValue({ select } as never);
    const { response } = createResponse();
    const next = jest.fn() as NextFunction;
    const request = { userId: 'admin-id' } as Request;

    await requireAdmin(request, response, next);

    expect(request.user).toBe(admin);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
