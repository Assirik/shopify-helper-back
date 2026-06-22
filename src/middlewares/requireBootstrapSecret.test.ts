import { describe, expect, it } from '@jest/globals';
import { isValidBootstrapSecret } from './requireBootstrapSecret';

describe('bootstrap secret validation', () => {
  const secret = 'a-secure-bootstrap-secret-of-32-chars';

  it('accepts the exact configured secret', () => {
    expect(isValidBootstrapSecret(secret, secret)).toBe(true);
  });

  it.each([undefined, '', 'wrong-secret', 'a'.repeat(secret.length)])('rejects %p', provided => {
    expect(isValidBootstrapSecret(provided, secret)).toBe(false);
  });

  it('disables secrets shorter than 32 characters', () => {
    expect(isValidBootstrapSecret('short', 'short')).toBe(false);
  });
});
