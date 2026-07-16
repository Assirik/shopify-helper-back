import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DeliveryFeeConfig } from '../../models/DeliveryFeeConfig';
import { DeliveryFeeConfigService, validateDeliveryFeeConfigUpdate } from './deliveryFeeConfig.service';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('delivery fee config service', () => {
  it('validates default and regional fee updates', () => {
    expect(
      validateDeliveryFeeConfigUpdate({
        defaultFee: 1000,
        regionFees: [
          { regionCode: 'sn_dk', amount: 1500 },
          { regionCode: 'SN_TH', amount: 2500 }
        ]
      })
    ).toEqual({
      update: {
        defaultFee: 1000,
        regionFees: [
          { regionCode: 'SN_DK', amount: 1500 },
          { regionCode: 'SN_TH', amount: 2500 }
        ]
      }
    });
  });

  it('rejects invalid delivery fee config payloads', () => {
    expect(
      validateDeliveryFeeConfigUpdate({
        defaultFee: -1,
        regionFees: [{ regionCode: 'UNKNOWN', amount: 'free' }]
      })
    ).toEqual({
      errors: {
        defaultFee: expect.any(String),
        'regionFees.0.regionCode': expect.any(String),
        'regionFees.0.amount': expect.any(String)
      }
    });
  });

  it('populates updatedBy with the user name when reading the config', async () => {
    const populatedConfig = {
      defaultFee: 1000,
      regionFees: [],
      updatedBy: { _id: '6a39dd4e8862d50323a51e53', userName: 'admin' }
    };
    const populate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(populatedConfig);
    jest.spyOn(DeliveryFeeConfig, 'findOneAndUpdate').mockReturnValue({ populate } as never);

    await expect(DeliveryFeeConfigService.getOrCreateConfig()).resolves.toBe(populatedConfig);
    expect(populate).toHaveBeenCalledWith('updatedBy', 'userName');
  });

  it('populates updatedBy with the user name when updating the config', async () => {
    const populatedConfig = {
      defaultFee: 1200,
      regionFees: [],
      updatedBy: { _id: '6a39dd4e8862d50323a51e53', userName: 'admin' }
    };
    const populate = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(populatedConfig);
    jest.spyOn(DeliveryFeeConfig, 'findOneAndUpdate').mockReturnValue({ populate } as never);

    await expect(
      DeliveryFeeConfigService.updateConfig({ defaultFee: 1200 }, '6a39dd4e8862d50323a51e53')
    ).resolves.toEqual({ config: populatedConfig });
    expect(populate).toHaveBeenCalledWith('updatedBy', 'userName');
  });

  it('resolves regional fees before the default fee', async () => {
    jest.spyOn(DeliveryFeeConfigService, 'getConfig').mockResolvedValue({
      defaultFee: 1000,
      regionFees: [{ regionCode: 'SN_DK', amount: 1500 }]
    } as never);

    await expect(DeliveryFeeConfigService.resolveDeliveryFee('SN_DK')).resolves.toBe(1500);
    await expect(DeliveryFeeConfigService.resolveDeliveryFee('SN_TH')).resolves.toBe(1000);
  });
});
