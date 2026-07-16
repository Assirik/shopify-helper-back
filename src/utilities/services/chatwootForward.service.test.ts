import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import crypto from 'crypto';
import config from '../config/env.config';
import { ChatwootForwardService } from './chatwootForward.service';

jest.mock('axios');

const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

const samplePayload = {
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ id: 'wamid.test', from: '221771234567', type: 'text' }] } }] }]
};

describe('ChatwootForwardService', () => {
  const originalChatwoot = { ...config.chatwoot };

  beforeEach(() => {
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    Object.assign(config.chatwoot, originalChatwoot);
  });

  it('is disabled when CHATWOOT_URL or the phone number is missing', async () => {
    Object.assign(config.chatwoot, { url: '', whatsappPhoneNumber: '' });

    expect(ChatwootForwardService.isEnabled()).toBe(false);
    await expect(ChatwootForwardService.forwardWhatsAppPayload(samplePayload)).resolves.toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('posts the raw payload to the Chatwoot ingestion endpoint with a Meta signature', async () => {
    Object.assign(config.chatwoot, {
      url: 'https://chatwoot.example.com',
      whatsappPhoneNumber: '+221703775324',
      metaAppSecret: 'test-secret'
    });

    await expect(ChatwootForwardService.forwardWhatsAppPayload(samplePayload)).resolves.toBe(true);

    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body, options] = mockedPost.mock.calls[0] as [string, string, { headers: Record<string, string> }];

    expect(url).toBe('https://chatwoot.example.com/webhooks/whatsapp/%2B221703775324');
    expect(body).toBe(JSON.stringify(samplePayload));

    const expectedSignature = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
    expect(options.headers['X-Hub-Signature-256']).toBe(`sha256=${expectedSignature}`);
  });

  it('omits the signature header when no secret is configured', async () => {
    Object.assign(config.chatwoot, {
      url: 'https://chatwoot.example.com',
      whatsappPhoneNumber: '+221703775324',
      metaAppSecret: ''
    });

    await ChatwootForwardService.forwardWhatsAppPayload(samplePayload);

    const [, , options] = mockedPost.mock.calls[0] as [string, string, { headers: Record<string, string> }];
    expect(options.headers['X-Hub-Signature-256']).toBeUndefined();
  });

  it('never throws when Chatwoot is unreachable', async () => {
    Object.assign(config.chatwoot, {
      url: 'https://chatwoot.example.com',
      whatsappPhoneNumber: '+221703775324',
      metaAppSecret: ''
    });
    mockedPost.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(ChatwootForwardService.forwardWhatsAppPayload(samplePayload)).resolves.toBe(false);
  });
});
