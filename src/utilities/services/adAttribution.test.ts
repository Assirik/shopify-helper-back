import { describe, expect, it } from '@jest/globals';
import { parseAdAttribution } from './adAttribution';

describe('parseAdAttribution', () => {
  it('reads utm_* attributes with trim', () => {
    expect(
      parseAdAttribution({
        utm_campaign: ' c1 ',
        utm_term: 'as1',
        utm_content: 'ad1',
        utm_source: 'facebook',
        utm_medium: 'paid'
      })
    ).toEqual({ campaignId: 'c1', adsetId: 'as1', adId: 'ad1', utmSource: 'facebook', utmMedium: 'paid' });
  });

  it('prefers the attributes over full_url utm_*', () => {
    expect(
      parseAdAttribution({ utm_campaign: 'attr', full_url: 'https://s.com/?utm_campaign=url&utm_source=ig' })
    ).toEqual({ campaignId: 'attr', utmSource: 'ig' });
  });

  it('always reads fbclid from full_url', () => {
    expect(parseAdAttribution({ utm_source: 'x', full_url: 'https://s.com/p?fbclid=AbC' })).toEqual({
      utmSource: 'x',
      fbclid: 'AbC'
    });
  });

  it('falls back on ad_id and campaign_id of the URL', () => {
    expect(parseAdAttribution({ full_url: 'https://s.com/?ad_id=7&campaign_id=9' })).toEqual({
      adId: '7',
      campaignId: '9'
    });
  });

  it('treats an empty attribute as missing and falls back on the URL', () => {
    expect(parseAdAttribution({ utm_content: '  ', full_url: 'https://s.com/?utm_content=u1' })).toEqual({
      adId: 'u1'
    });
  });

  it('falls back on utm_term and utm_medium of the URL', () => {
    expect(
      parseAdAttribution({ full_url: 'https://shop.example.com/p?utm_term=as1&utm_medium=paid' })
    ).toStrictEqual({ adsetId: 'as1', utmMedium: 'paid' });
  });

  it('never returns an empty fbclid', () => {
    const result = parseAdAttribution({ full_url: 'https://shop.example.com/p?fbclid=&utm_source=fb' });

    expect(result).toStrictEqual({ utmSource: 'fb' });
    expect('fbclid' in result).toBe(false);
  });

  it.each([
    [undefined],
    [null],
    [{}],
    [{ full_url: 'not a url' }],
    [{ full_url: '/relative?fbclid=x' }],
    [{ full_url: '   ', utm_source: '' }]
  ])('returns no field for %p', input => {
    expect(parseAdAttribution(input as never)).toEqual({});
  });
});
