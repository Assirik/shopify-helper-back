import { describe, expect, it } from '@jest/globals';
import { isValidEmail, isValidPassword, isValidUserName } from './userCredentials';

describe('user credential validation', () => {
  it.each([
    ['admin', true],
    ['helpdesk.agent-1', true],
    ['ab', false],
    ['admin user', false]
  ])('validates username %p as %p', (value, expected) => {
    expect(isValidUserName(value)).toBe(expected);
  });

  it.each([
    ['admin@example.com', true],
    ['not-an-email', false],
    ['', false]
  ])('validates email %p as %p', (value, expected) => {
    expect(isValidEmail(value)).toBe(expected);
  });

  it('enforces bcrypt password byte limits', () => {
    expect(isValidPassword('12345678')).toBe(true);
    expect(isValidPassword('1234567')).toBe(false);
    expect(isValidPassword('a'.repeat(73))).toBe(false);
  });
});
