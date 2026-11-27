import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ErrorEvent } from '@sentry/node';
import { sanitizeEvent, scrubDeep, scrubPhones } from './scrub';

describe('scrubPhones', () => {
  it.each([
    ['call +221776986780 now', 'call [phone] now'],
    ['call +221 77 698 67 80 now', 'call [phone] now'],
    ['wa_id 221776986780 here', 'wa_id [phone] here'],
    ['shopify 77 698 67 80 raw', 'shopify [phone] raw'],
    ['local 776986780 here', 'local [phone] here'],
    ['object 507f1f77bcf86cd799439011 id', 'object 507f1f77bcf86cd799439011 id'],
    ['digits 123456789012345678901234 id', 'digits 123456789012345678901234 id'],
    ['order 1234567890123 stays', 'order 1234567890123 stays'],
    ['no phone', 'no phone']
  ])('%s', (input, expected) => {
    expect(scrubPhones(input)).toBe(expected);
  });
});

describe('scrubDeep', () => {
  it('drops request/config-like keys and masks phones in nested strings', () => {
    const out = scrubDeep({
      note: 'client +221776986780',
      config: { headers: { Authorization: 'Bearer secret' } },
      nested: { list: ['776986780', { data: 'body', ok: 1 }] }
    });
    expect(out).toEqual({ note: 'client [phone]', nested: { list: ['[phone]', { ok: 1 }] } });
  });
});

describe('sanitizeEvent', () => {
  it('removes body, cookies, headers, query string and user, masks url and phones', () => {
    const event = {
      type: undefined,
      message: 'failed for +221776986780',
      user: { id: '1', email: 'a@b.c', ip_address: '1.2.3.4' },
      request: {
        method: 'POST',
        url: 'https://api.example.com/api/orders?search=776986780&page=2',
        data: { phone: '+221776986780' },
        cookies: { sid: 'x' },
        headers: { authorization: 'Bearer abc', cookie: 'sid=x', 'x-hub-signature-256': 'sig' },
        query_string: 'search=776986780'
      },
      exception: { values: [{ type: 'Error', value: 'bad number 776986780', stacktrace: { frames: [{ vars: { body: 'x' } }] } }] },
      sdkProcessingMetadata: { normalizedRequest: { headers: { authorization: 'Bearer abc' } }, ipAddress: '1.2.3.4' },
      extra: { phone: '+221776986780', config: { headers: { Authorization: 'x' } } },
      breadcrumbs: [{ message: 'to +221776986780', data: { url: 'https://graph.facebook.com/?access_token=abc' } }]
    } as unknown as ErrorEvent;

    const out = sanitizeEvent(event);

    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({
      method: 'POST',
      url: 'https://api.example.com/api/orders?search=[Redacted]&page=2'
    });
    expect(out.message).toBe('failed for [phone]');
    expect(out.exception?.values?.[0].value).toBe('bad number [phone]');
    expect(out.exception?.values?.[0].stacktrace?.frames?.[0]).toEqual({});
    expect(out.sdkProcessingMetadata).toEqual({});
    expect(out.extra).toEqual({ phone: '[phone]' });
    expect(out.breadcrumbs).toEqual([{ message: 'to [phone]' }]);
    expect(JSON.stringify(out)).not.toMatch(/776986780|Bearer|access_token|sig/);
  });

  it('tolerates an event without request', () => {
    expect(() => sanitizeEvent({} as ErrorEvent)).not.toThrow();
  });
});
