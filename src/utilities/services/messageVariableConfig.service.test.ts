import { describe, expect, it } from '@jest/globals';
import {
  classifyDeliveryRegion,
  validateMessageVariableUpdate
} from './messageVariableConfig.service';

describe('classifyDeliveryRegion', () => {
  it.each([
    ['Dakar', 'dakar'],
    ['Région de Dakar', 'dakar'],
    ['DAKAR', 'dakar'],
    ['Hors Dakar', 'nonDakar'],
    ['Non Dakar', 'nonDakar'],
    ['Thiès', 'nonDakar'],
    ['Région de Thiès', 'nonDakar'],
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['Dakar banlieue inconnue', 'unknown']
  ])('classifies %s as %s', (region, expected) => {
    expect(classifyDeliveryRegion(region)).toBe(expected);
  });
});

describe('validateMessageVariableUpdate', () => {
  it('accepts a complete configuration and trims values', () => {
    expect(
      validateMessageVariableUpdate({
        shippingNote: { dakar: '  Livraison Dakar  ', nonDakar: 'Expédition région' },
        paymentMethod: { dakar: 'Paiement livraison', nonDakar: 'Paiement avant envoi' }
      })
    ).toEqual({
      update: {
        shippingNote: { dakar: 'Livraison Dakar', nonDakar: 'Expédition région' },
        paymentMethod: { dakar: 'Paiement livraison', nonDakar: 'Paiement avant envoi' }
      }
    });
  });

  it('accepts partial updates and explicit resets', () => {
    expect(validateMessageVariableUpdate({ shippingNote: { dakar: null } })).toEqual({
      update: { shippingNote: { dakar: null } }
    });
    expect(validateMessageVariableUpdate({ paymentMethod: { nonDakar: '   ' } })).toEqual({
      update: { paymentMethod: { nonDakar: null } }
    });
  });

  it.each([
    [42],
    [[]],
    [{ unknown: { dakar: 'x' } }],
    [{ shippingNote: { unknown: 'x' } }],
    [{ shippingNote: { dakar: 42 } }],
    [{ shippingNote: ['x'] }]
  ])('rejects invalid payload %p', payload => {
    expect(validateMessageVariableUpdate(payload)).toEqual({ errors: expect.any(Object) });
  });
});
