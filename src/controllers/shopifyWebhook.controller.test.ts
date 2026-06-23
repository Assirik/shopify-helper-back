import { describe, expect, it, jest } from '@jest/globals';

jest.mock('../queues/notification.queue', () => ({
  enqueueOrderConfirmation: jest.fn()
}));

import { extractDeliverySnapshot, normalizeDeliveryMoment } from './shopifyWebhook.controller';

describe('extractDeliverySnapshot', () => {
  it('extracts the immutable delivery snapshot observed in Shopify payload 6', () => {
    const snapshot = extractDeliverySnapshot({
      shipping_address: {
        province: null,
        address2: 'Cap Skiring',
        latitude: 12.5072598,
        longitude: -16.6630268
      },
      browser_ip: null,
      customer_locale: null,
      note_attributes: [
        { name: 'Région', value: 'Ziguinchor' },
        { name: 'Adresse de livraison', value: 'Cap Skiring' },
        { name: 'Moment de livraison préféré', value: 'Après Midi' },
        { name: 'IP Address', value: '154.124.16.8' }
      ]
    });

    expect(snapshot).toEqual({
      deliveryRegion: 'Ziguinchor',
      deliveryRegionCode: 'SN_ZG',
      deliveryPreferredMoment: 'Après Midi',
      deliveryAddress: 'Cap Skiring',
      deliveryLatitude: 12.5072598,
      deliveryLongitude: -16.6630268,
      browserIp: '154.124.16.8',
      customerLocale: undefined
    });
  });

  it('falls back to Shopify city and address1 when Easysell delivery fields are absent', () => {
    const snapshot = extractDeliverySnapshot({
      shipping_address: {
        province: null,
        city: 'Dakar',
        address1: 'Mbao',
        address2: null
      }
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        deliveryRegion: 'Dakar',
        deliveryRegionCode: 'SN_DK',
        deliveryAddress: 'Mbao'
      })
    );
  });
});

describe('normalizeDeliveryMoment', () => {
  it.each([
    ['Après Midi', 'apres midi'],
    ['Après-midi', 'apres midi'],
    ['APRÈS  MIDI', 'apres midi'],
    ['Matinée', 'matinee'],
    ['Soir (avant 20h)', 'soir (avant 20h)']
  ])('normalizes %p to %p (accent/case/hyphen tolerant)', (input, expected) => {
    expect(normalizeDeliveryMoment(input)).toBe(expected);
  });
});
