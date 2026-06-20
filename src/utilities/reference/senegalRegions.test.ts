import { describe, expect, it } from '@jest/globals';
import { SENEGAL_REGIONS, isHomeDeliveryRegion, resolveRegion } from './senegalRegions';

describe('senegalRegions', () => {
  it('contains the 14 canonical Senegal regions', () => {
    expect(SENEGAL_REGIONS).toHaveLength(14);
    expect(new Set(SENEGAL_REGIONS.map(region => region.code)).size).toBe(14);
  });

  it.each([
    ['Dakar', 'SN_DK'],
    ['Région de Dakar', 'SN_DK'],
    ['SN_DK', 'SN_DK'],
    ['Thiès Region', 'SN_TH'],
    ['Thies', 'SN_TH'],
    ['Ziguinchor', 'SN_ZG'],
    ['SN_ZG', 'SN_ZG']
  ])('resolves %s to %s', (input, expectedCode) => {
    expect(resolveRegion(input)?.code).toBe(expectedCode);
  });

  it('returns undefined for unknown or synthetic regions', () => {
    expect(resolveRegion('Hors Dakar')).toBeUndefined();
    expect(resolveRegion('')).toBeUndefined();
    expect(resolveRegion(undefined)).toBeUndefined();
  });

  it('identifies only Dakar as the current home-delivery zone', () => {
    expect(isHomeDeliveryRegion('Dakar')).toBe(true);
    expect(isHomeDeliveryRegion('Région de Dakar')).toBe(true);
    expect(isHomeDeliveryRegion('Hors Dakar')).toBe(false);
    expect(isHomeDeliveryRegion('Ziguinchor')).toBe(false);
    expect(isHomeDeliveryRegion()).toBe(false);
  });
});
