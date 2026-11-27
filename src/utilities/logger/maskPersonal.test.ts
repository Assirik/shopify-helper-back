import { describe, expect, it } from '@jest/globals';
import { maskEmail, maskName } from './maskPersonal';

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('amadou.diallo@example.com')).toBe('a***@example.com');
  });
  it('hides anything that is not an address', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });
  it('passes empty values through', () => {
    expect(maskEmail(undefined)).toBeUndefined();
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail('')).toBe('');
  });
});

describe('maskName', () => {
  it('keeps only the initial', () => {
    expect(maskName('Amadou Diallo')).toBe('A***');
    expect(maskName('  fatou')).toBe('f***');
  });
  it('passes empty values through', () => {
    expect(maskName(undefined)).toBeUndefined();
    expect(maskName('')).toBe('');
    expect(maskName('   ')).toBe('***');
  });
});
