// Query parameters whose values may appear in logs. Everything else (tokens, phone, email,
// search text, unknown keys) is masked. Keys are compared decoded and lower-cased.
const ALLOWED_QUERY_KEYS = new Set([
  'page',
  'limit',
  'status',
  'reason',
  'channel',
  'provider',
  'ordername',
  'cod',
  'hidecompleted',
  'hidecancelled',
  'active',
  'role',
  'date',
  'courierid',
  'after',
  'customerconfirmationstatus',
  'operationalstatus',
  'hub.mode',
  'hub.challenge'
]);

const decodeKey = (rawKey: string): string => {
  const spaced = rawKey.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced).toLowerCase();
  } catch {
    return spaced.toLowerCase();
  }
};

// Masks the value of every query parameter that is not on the allow-list; keys are kept as sent.
export const maskUrl = (url: string | undefined): string | undefined => {
  if (url === undefined) return url;
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const hashStart = url.indexOf('#', queryStart);
  const queryEnd = hashStart === -1 ? url.length : hashStart;
  const masked = url
    .slice(queryStart + 1, queryEnd)
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return part;
      const key = part.slice(0, eq);
      return ALLOWED_QUERY_KEYS.has(decodeKey(key)) ? part : `${key}=[Redacted]`;
    })
    .join('&');

  return `${url.slice(0, queryStart + 1)}${masked}${url.slice(queryEnd)}`;
};
