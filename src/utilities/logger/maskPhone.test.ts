import { describe, expect, it } from '@jest/globals';
import { maskPhone } from './maskPhone';

describe('maskPhone', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskPhone('+221771234567')).toBe('***4567');
  });

  it('passes empty and undefined values through', () => {
    expect(maskPhone(undefined)).toBeUndefined();
    expect(maskPhone('')).toBe('');
  });
});
