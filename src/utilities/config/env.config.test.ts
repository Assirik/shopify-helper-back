import { describe, expect, it } from '@jest/globals';
import { buildMetaCapiConfig, DEFAULT_FX_XOF_EUR, parseSessionCaptureOrigins } from './env.config';
import { checkCapiStartup } from './capiStartup';

describe('buildMetaCapiConfig', () => {
  it('uses safe defaults with an empty environment', () => {
    expect(buildMetaCapiConfig({})).toEqual({
      enabled: false,
      datasetId: '',
      accessToken: '',
      graphApiVersion: 'v26.0',
      fxXofEur: 655.957,
      testEventCode: ''
    });
  });

  it('enables only on the exact string "true"', () => {
    expect(buildMetaCapiConfig({ META_CAPI_ENABLED: 'true' }).enabled).toBe(true);
    expect(buildMetaCapiConfig({ META_CAPI_ENABLED: 'false' }).enabled).toBe(false);
    expect(buildMetaCapiConfig({ META_CAPI_ENABLED: '1' }).enabled).toBe(false);
  });

  it('reads the overrides', () => {
    const c = buildMetaCapiConfig({
      META_CAPI_DATASET_ID: 'd',
      META_CAPI_ACCESS_TOKEN: 't',
      META_CAPI_GRAPH_API_VERSION: 'v27.0',
      META_CAPI_FX_XOF_EUR: '600',
      META_CAPI_TEST_EVENT_CODE: 'TEST1'
    });
    expect(c).toMatchObject({ datasetId: 'd', accessToken: 't', graphApiVersion: 'v27.0', fxXofEur: 600, testEventCode: 'TEST1' });
  });

  it('trims string values and falls back to v26.0 for a blank version', () => {
    const c = buildMetaCapiConfig({
      META_CAPI_DATASET_ID: ' d ',
      META_CAPI_ACCESS_TOKEN: ' t ',
      META_CAPI_GRAPH_API_VERSION: '   ',
      META_CAPI_TEST_EVENT_CODE: ' TEST1 '
    });
    expect(c).toMatchObject({ datasetId: 'd', accessToken: 't', graphApiVersion: 'v26.0', testEventCode: 'TEST1' });
  });

  it('turns whitespace-only dataset and token into empty strings', () => {
    const c = buildMetaCapiConfig({ META_CAPI_DATASET_ID: '   ', META_CAPI_ACCESS_TOKEN: '  ' });
    expect(c).toMatchObject({ datasetId: '', accessToken: '' });
  });

  it.each(['abc', '0', '-5', '', 'NaN', 'Infinity'])('falls back to the default rate for %p', value => {
    expect(buildMetaCapiConfig({ META_CAPI_FX_XOF_EUR: value }).fxXofEur).toBe(DEFAULT_FX_XOF_EUR);
  });
});

describe('checkCapiStartup', () => {
  it('fails when enabled without token', () => {
    expect(checkCapiStartup({ enabled: true, datasetId: 'd', accessToken: '' })).toContain('CapiNotConfigured');
  });
  it('fails when enabled without dataset', () => {
    expect(checkCapiStartup({ enabled: true, datasetId: '', accessToken: 't' })).toContain('CapiNotConfigured');
  });
  it('fails when enabled with a whitespace-only dataset or token', () => {
    expect(checkCapiStartup({ enabled: true, datasetId: '   ', accessToken: 't' })).toContain('CapiNotConfigured');
    expect(checkCapiStartup({ enabled: true, datasetId: 'd', accessToken: '  ' })).toContain('CapiNotConfigured');
  });
  it('passes when disabled, even if incomplete', () => {
    expect(checkCapiStartup({ enabled: false, datasetId: '', accessToken: '' })).toBeNull();
  });
  it('passes when enabled and complete', () => {
    expect(checkCapiStartup({ enabled: true, datasetId: 'd', accessToken: 't' })).toBeNull();
  });
});

describe('parseSessionCaptureOrigins', () => {
  it('returns an empty list when the variable is absent or blank', () => {
    expect(parseSessionCaptureOrigins(undefined)).toEqual([]);
    expect(parseSessionCaptureOrigins(' , ')).toEqual([]);
  });

  it('trims, lowercases and drops trailing slashes', () => {
    expect(parseSessionCaptureOrigins(' https://Shop.example.com/ ,https://www.shop.example.com')).toEqual([
      'https://shop.example.com',
      'https://www.shop.example.com'
    ]);
  });
});
