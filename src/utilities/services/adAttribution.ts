export interface AdAttribution {
  fbclid?: string;
  adId?: string;
  campaignId?: string;
  adsetId?: string;
  utmSource?: string;
  utmMedium?: string;
}

const clean = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseSearchParams = (fullUrl: string | undefined): URLSearchParams | undefined => {
  if (!fullUrl) {
    return undefined;
  }

  try {
    return new URL(fullUrl).searchParams;
  } catch {
    // Invalid or relative URL: no attribution from it.
    return undefined;
  }
};

/**
 * Reads the advertising origin of an order from the EasySell note attributes.
 *
 * Priority: `utm_*` attributes; `full_url` is used for `fbclid` (always) and as a fallback
 * (utm_*, ad_id, campaign_id) only when the matching attribute is missing. Never throws.
 */
export const parseAdAttribution = (noteAttributes: Record<string, string> | undefined | null): AdAttribution => {
  const attrs = noteAttributes || {};
  const params = parseSearchParams(clean(attrs.full_url));
  const fromUrl = (key: string) => clean(params?.get(key));

  const result: AdAttribution = {
    fbclid: fromUrl('fbclid'),
    campaignId: clean(attrs.utm_campaign) ?? fromUrl('utm_campaign') ?? fromUrl('campaign_id'),
    adsetId: clean(attrs.utm_term) ?? fromUrl('utm_term'),
    adId: clean(attrs.utm_content) ?? fromUrl('utm_content') ?? fromUrl('ad_id'),
    utmSource: clean(attrs.utm_source) ?? fromUrl('utm_source'),
    utmMedium: clean(attrs.utm_medium) ?? fromUrl('utm_medium')
  };

  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined)) as AdAttribution;
};
