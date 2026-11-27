import type { ErrorEvent } from '@sentry/node';
import { maskUrl } from '../logger/maskUrl';

const PHONE_PLACEHOLDER = '[phone]';
// Phone numbers: 9 to 12 digits, optional leading +, optional space/dot/dash separators, bounded by
// non-word characters (so ids mixing letters and digits, e.g. 24-char ObjectIds, and 13-digit ids stay intact).
const PHONE = /(?<!\w)\+?\d(?:[\s.-]?\d){8,11}(?!\w)/g;

const MAX_DEPTH = 6;
// Keys whose content is never useful for triage and often carries credentials or customer data
// (an AxiosError attaches its whole request config, headers and body, to the error object).
const DROPPED_KEYS = new Set(['config', 'request', 'response', 'headers', 'authorization', 'cookie', 'cookies', 'data', 'body']);

export const scrubPhones = (text: string): string =>
  text.replace(PHONE, PHONE_PLACEHOLDER);

export const scrubDeep = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return scrubPhones(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_KEYS.has(key.toLowerCase())) continue;
    out[key] = scrubDeep(item, depth + 1);
  }
  return out;
};

// Sentry beforeSend: strips everything personal or secret before an event leaves the process.
export const sanitizeEvent = (event: ErrorEvent): ErrorEvent => {
  if (event.request) {
    const { method, url } = event.request;
    event.request = { method, url: url === undefined ? url : scrubPhones(maskUrl(url) as string) };
  }

  delete event.user;

  if (event.transaction) event.transaction = scrubPhones(event.transaction);
  if (event.tags) {
    // request_id is our own uuid: leave it untouched.
    for (const [key, value] of Object.entries(event.tags)) {
      if (key !== 'request_id' && typeof value === 'string') event.tags[key] = scrubPhones(value);
    }
  }
  if (event.contexts) event.contexts = scrubDeep(event.contexts) as typeof event.contexts;

  if (event.message) event.message = scrubPhones(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubPhones(exception.value);
    // Local variables captured on frames can hold request bodies or phone numbers.
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }

  // Internal scratch data (raw request headers, client IP) normally stripped before sending: drop it regardless.
  if (event.sdkProcessingMetadata) {
    delete event.sdkProcessingMetadata.normalizedRequest;
    delete event.sdkProcessingMetadata.ipAddress;
  }

  if (event.extra) event.extra = scrubDeep(event.extra) as typeof event.extra;

  if (event.breadcrumbs) {
    // `data` (outgoing request URLs, console arguments) is dropped on purpose.
    event.breadcrumbs = event.breadcrumbs.map(({ data: _data, message, ...crumb }) => ({
      ...crumb,
      ...(message ? { message: scrubPhones(message) } : {})
    }));
  }

  return event;
};
