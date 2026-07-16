import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { MessageVariableConfig } from '../../models/MessageVariableConfig';
import {
  classifyDeliveryRegion,
  MessageVariableConfigService,
  validateMessageVariableUpdate
} from './messageVariableConfig.service';

afterEach(() => {
  jest.restoreAllMocks();
});

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

describe('MessageVariableConfigService', () => {
  const populatedConfig = {
    shippingNote: { dakar: 'Livraison Dakar' },
    paymentMethod: {},
    updatedBy: { _id: '6a39dd4e8862d50323a51e53', userName: 'admin' }
  };

  it('getConfigWithEditor populates updatedBy with the user name', async () => {
    const populate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(populatedConfig);
    jest.spyOn(MessageVariableConfig, 'findOne').mockReturnValue({ populate } as never);

    await expect(MessageVariableConfigService.getConfigWithEditor()).resolves.toBe(populatedConfig);
    expect(populate).toHaveBeenCalledWith('updatedBy', 'userName');
  });

  it('updateConfig populates updatedBy with the user name', async () => {
    const populate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(populatedConfig);
    jest.spyOn(MessageVariableConfig, 'findOneAndUpdate').mockReturnValue({ populate } as never);

    await expect(
      MessageVariableConfigService.updateConfig(
        { shippingNote: { dakar: 'Livraison Dakar' } },
        '6a39dd4e8862d50323a51e53'
      )
    ).resolves.toEqual({ config: populatedConfig });
    expect(populate).toHaveBeenCalledWith('updatedBy', 'userName');
  });
});
