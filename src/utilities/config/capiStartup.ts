export interface CapiStartupConfig {
  enabled: boolean;
  enabledInvalid?: boolean;
  datasetId: string;
  accessToken: string;
}

export interface CapiStatusConfig extends CapiStartupConfig {
  graphApiVersion: string;
  testEventCode: string;
}

/**
 * Returns an error message (containing `CapiNotConfigured`) when META_CAPI_ENABLED holds
 * an unrecognized value, or when CAPI sending is enabled but the dataset or the token is
 * missing (empty or whitespace-only); returns `null` otherwise. Never includes a secret
 * nor the raw value of the variable.
 */
export const checkCapiStartup = (capi: CapiStartupConfig): string | null => {
  if (capi.enabledInvalid) {
    return "CapiNotConfigured: META_CAPI_ENABLED must be 'true' or 'false' (case and surrounding spaces ignored), or absent/empty to disable";
  }
  if (!capi.enabled) return null;
  const missing: string[] = [];
  if (!capi.datasetId.trim()) missing.push('META_CAPI_DATASET_ID');
  if (!capi.accessToken.trim()) missing.push('META_CAPI_ACCESS_TOKEN');
  if (missing.length === 0) return null;
  return `CapiNotConfigured: META_CAPI_ENABLED=true but missing ${missing.join(', ')}`;
};

/**
 * Startup log fields for the CAPI state. Presence flags only: neither the token,
 * the dataset id nor the test event code is ever exposed.
 */
export const describeCapiStatus = (capi: CapiStatusConfig) => ({
  enabled: capi.enabled,
  datasetPresent: Boolean(capi.datasetId.trim()),
  graphApiVersion: capi.graphApiVersion,
  testEventCodePresent: Boolean(capi.testEventCode.trim())
});
