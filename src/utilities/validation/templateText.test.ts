import { describe, expect, it } from '@jest/globals';
import { MAX_TEMPLATE_PARAM_LENGTH, validateTemplateText } from './templateText';

describe('validateTemplateText', () => {
  it('accepts and trims a valid value', () => {
    expect(validateTemplateText('  Colis à poster sous 48h  ')).toEqual({ value: 'Colis à poster sous 48h' });
  });

  it('rejects a non-string value', () => {
    expect(validateTemplateText(42)).toEqual({ error: expect.any(String) });
  });

  it('rejects an empty or whitespace-only value', () => {
    expect(validateTemplateText('   ')).toEqual({ error: expect.any(String) });
  });

  it('rejects newlines and tabs', () => {
    expect(validateTemplateText('Ligne 1\nLigne 2')).toEqual({ error: expect.any(String) });
    expect(validateTemplateText('A\tB')).toEqual({ error: expect.any(String) });
  });

  it('rejects more than 4 consecutive spaces', () => {
    expect(validateTemplateText('Paiement      à la livraison')).toEqual({ error: expect.any(String) });
  });

  it('rejects values longer than the max length', () => {
    expect(validateTemplateText('x'.repeat(MAX_TEMPLATE_PARAM_LENGTH + 1))).toEqual({ error: expect.any(String) });
  });
});
