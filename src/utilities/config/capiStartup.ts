export interface CapiStartupConfig {
  enabled: boolean;
  datasetId: string;
  accessToken: string;
}

/**
 * Returns an error message (containing `CapiNotConfigured`) when CAPI sending is
 * enabled but the dataset or the token is missing (empty or whitespace-only);
 * returns `null` otherwise.
 */
export const checkCapiStartup = (capi: CapiStartupConfig): string | null => {
  if (!capi.enabled) return null;
  const missing: string[] = [];
  if (!capi.datasetId.trim()) missing.push('META_CAPI_DATASET_ID');
  if (!capi.accessToken.trim()) missing.push('META_CAPI_ACCESS_TOKEN');
  if (missing.length === 0) return null;
  return `CapiNotConfigured: META_CAPI_ENABLED=true but missing ${missing.join(', ')}`;
};
