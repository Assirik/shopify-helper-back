import { describe, expect, it } from '@jest/globals';
import { PhoneNormalizationService } from './phoneNormalization.service';

describe('PhoneNormalizationService.normalizeSenegalPhone', () => {
  const validCases: Array<[string, string]> = [
    ['771234567', '+221771234567'],
    ['77 123 45 67', '+221771234567'],
    ['77-123-45-67', '+221771234567'],
    ['(77) 123 45 67', '+221771234567'],
    ['221771234567', '+221771234567'],
    ['+221771234567', '+221771234567'],
    ['+221 77 123 45 67', '+221771234567'],
    ['70 123 45 67', '+221701234567'],
    ['71 123 45 67', '+221711234567'],
    ['72 123 45 67', '+221721234567'],
    ['75 123 45 67', '+221751234567'],
    ['76 123 45 67', '+221761234567'],
    ['78 123 45 67', '+221781234567'],
    ['79 123 45 67', '+221791234567']
  ];

  it.each(validCases)('normalizes %s to %s', (input, expected) => {
    const result = PhoneNormalizationService.normalizeSenegalPhone(input);

    expect(result).toMatchObject({
      raw: input,
      isValid: true,
      e164: expected
    });
    expect(result.errorReason).toBeUndefined();
  });

  const invalidCases: Array<[string | null | undefined, string]> = [
    [undefined, 'Phone number is required'],
    ['', 'Phone number is required'],
    ['   ', 'Phone number is required'],
    ['77123456', 'Phone number must be Senegalese and contain 9 local digits'],
    ['22177123456', 'Phone number must be Senegalese and contain 9 local digits'],
    ['+33123456789', 'Phone number must be Senegalese and contain 9 local digits'],
    ['731234567', 'Unsupported Senegal mobile prefix: 73'],
    ['77 123 AB 67', 'Phone number contains unsupported characters'],
    ['00221771234567', 'Phone number must be Senegalese and contain 9 local digits']
  ];

  it.each(invalidCases)('rejects %s with %s', (input, expectedReason) => {
    const result = PhoneNormalizationService.normalizeSenegalPhone(input);

    expect(result.isValid).toBe(false);
    expect(result.e164).toBeUndefined();
    expect(result.errorReason).toBe(expectedReason);
  });
});
