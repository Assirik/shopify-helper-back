import { describe, expect, it } from '@jest/globals';
import {
  buildMetaCapiConfig,
  DEFAULT_FX_XOF_EUR,
  parseInitialConfirmationRequestDelayMinutes,
  parseSessionCaptureOrigins
} from './env.config';
import { checkCapiStartup, describeCapiStatus } from './capiStartup';

describe('buildMetaCapiConfig', () => {
  it('uses safe defaults with an empty environment', () => {
    expect(buildMetaCapiConfig({})).toEqual({
      enabled: false,
      enabledInvalid: false,
      datasetId: '',
      accessToken: '',
      graphApiVersion: 'v26.0',
      fxXofEur: 655.957,
      testEventCode: ''
    });
  });

  it.each(['true', 'TRUE', 'True', ' true ', '\ttrue\n'])('enables with %p', value => {
    expect(buildMetaCapiConfig({ META_CAPI_ENABLED: value })).toMatchObject({ enabled: true, enabledInvalid: false });
  });

  it.each(['false', 'FALSE', ' False ', '', '   ', undefined])('stays off, valid, with %p', value => {
    expect(buildMetaCapiConfig({ META_CAPI_ENABLED: value })).toMatchObject({ enabled: false, enabledInvalid: false });
  });

  it.each(['1', '0', 'oui', 'yes', 'on', 'truee', 'vrai'])('stays off and is flagged invalid with %p', value => {
    expect(buildMetaCapiConfig({ META_CAPI_ENABLED: value })).toMatchObject({ enabled: false, enabledInvalid: true });
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
  it.each(['1', 'oui'])('refuses at startup the invalid value %p without echoing it', value => {
    const message = checkCapiStartup(buildMetaCapiConfig({ META_CAPI_ENABLED: value, META_CAPI_ACCESS_TOKEN: 'secret-token' }));
    expect(message).toContain('CapiNotConfigured');
    expect(message).toContain('META_CAPI_ENABLED');
    expect(message).not.toContain('secret-token');
    expect(message).not.toMatch(new RegExp(`=${value}\\b`));
  });
  it('accepts at startup TRUE and " true " with dataset and token, and absent or empty as off', () => {
    const full = { META_CAPI_DATASET_ID: 'd', META_CAPI_ACCESS_TOKEN: 't' };
    expect(checkCapiStartup(buildMetaCapiConfig({ ...full, META_CAPI_ENABLED: 'TRUE' }))).toBeNull();
    expect(checkCapiStartup(buildMetaCapiConfig({ ...full, META_CAPI_ENABLED: ' true ' }))).toBeNull();
    expect(checkCapiStartup(buildMetaCapiConfig({ META_CAPI_ENABLED: ' TRUE ' }))).toContain('missing META_CAPI_DATASET_ID');
    expect(checkCapiStartup(buildMetaCapiConfig({}))).toBeNull();
    expect(checkCapiStartup(buildMetaCapiConfig({ META_CAPI_ENABLED: '' }))).toBeNull();
  });
  it('passes when disabled, even if incomplete', () => {
    expect(checkCapiStartup({ enabled: false, datasetId: '', accessToken: '' })).toBeNull();
  });
  it('passes when enabled and complete', () => {
    expect(checkCapiStartup({ enabled: true, datasetId: 'd', accessToken: 't' })).toBeNull();
  });
});

describe('describeCapiStatus', () => {
  it('reports presence flags and the Graph version, never the secrets', () => {
    const status = describeCapiStatus(
      buildMetaCapiConfig({
        META_CAPI_ENABLED: 'true',
        META_CAPI_DATASET_ID: 'dataset-123456',
        META_CAPI_ACCESS_TOKEN: 'secret-token-abc',
        META_CAPI_GRAPH_API_VERSION: 'v27.0',
        META_CAPI_TEST_EVENT_CODE: 'TEST98765'
      })
    );
    expect(status).toEqual({ enabled: true, datasetPresent: true, graphApiVersion: 'v27.0', testEventCodePresent: true });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('dataset-123456');
    expect(serialized).not.toContain('secret-token-abc');
    expect(serialized).not.toContain('TEST98765');
  });

  it('reports a disabled CAPI with nothing configured', () => {
    expect(describeCapiStatus(buildMetaCapiConfig({}))).toEqual({
      enabled: false,
      datasetPresent: false,
      graphApiVersion: 'v26.0',
      testEventCodePresent: false
    });
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

describe('parseInitialConfirmationRequestDelayMinutes', () => {
  it('defaults to 5 minutes when the variable is absent or invalid', () => {
    expect(parseInitialConfirmationRequestDelayMinutes(undefined)).toBe(5);
    expect(parseInitialConfirmationRequestDelayMinutes('')).toBe(5);
    expect(parseInitialConfirmationRequestDelayMinutes('abc')).toBe(5);
    expect(parseInitialConfirmationRequestDelayMinutes('Infinity')).toBe(5);
  });

  it.each(['4', '1', '0', '-3', '4.9'])('raises %p to the 5 minute minimum', value => {
    expect(parseInitialConfirmationRequestDelayMinutes(value)).toBe(5);
  });

  it('keeps a longer delay', () => {
    expect(parseInitialConfirmationRequestDelayMinutes('5')).toBe(5);
    expect(parseInitialConfirmationRequestDelayMinutes('10')).toBe(10);
  });
});
