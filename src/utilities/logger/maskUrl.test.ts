import { describe, expect, it } from '@jest/globals';
import { maskUrl } from './maskUrl';

describe('maskUrl', () => {
  it('keeps allow-listed values and masks the rest', () => {
    expect(maskUrl('/a?page=2&hub.verify_token=s&limit=10&access_token=t')).toBe(
      '/a?page=2&hub.verify_token=[Redacted]&limit=10&access_token=[Redacted]'
    );
  });

  it('masks encoded keys', () => {
    expect(maskUrl('/a?hub%2Everify_token=s&ph%6Fne=%2B221776986780')).toBe(
      '/a?hub%2Everify_token=[Redacted]&ph%6Fne=[Redacted]'
    );
  });

  it('keeps an allow-listed key even when encoded or differently cased', () => {
    expect(maskUrl('/a?P%61ge=3&courierId=x')).toBe('/a?P%61ge=3&courierId=x');
  });

  it('masks every occurrence of a repeated parameter', () => {
    expect(maskUrl('/a?phone=1&phone=2&page=1&page=2')).toBe('/a?phone=[Redacted]&phone=[Redacted]&page=1&page=2');
  });

  it('masks unknown keys, handles malformed encoding, no query and undefined', () => {
    expect(maskUrl('/a?foo=bar&%E0%A4%A=x')).toBe('/a?foo=[Redacted]&%E0%A4%A=[Redacted]');
    expect(maskUrl('/a/b')).toBe('/a/b');
    expect(maskUrl(undefined)).toBeUndefined();
  });

  it('preserves a fragment', () => {
    expect(maskUrl('/a?token=x#frag')).toBe('/a?token=[Redacted]#frag');
  });
});
