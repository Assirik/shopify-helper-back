import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';
import config from '../config/env.config';
import { MetaWhatsAppProvider } from '../../providers/metaWhatsApp.provider';
import { ChatwootOutboundMirrorService, OutboundMirrorInput } from './chatwootOutboundMirror.service';

jest.mock('axios');
jest.mock('../../providers/metaWhatsApp.provider');

const mockedCreate = axios.create as jest.MockedFunction<typeof axios.create>;
const mockedProvider = MetaWhatsAppProvider as jest.MockedClass<typeof MetaWhatsAppProvider>;

const templateBody =
  '👋{{greeting}} {{name}} !\nVotre commande {{order_no}} chez Alkima a bien été reçue. ✅\nMontant : {{amount}} XOF';

const baseInput: OutboundMirrorInput = {
  to: '+221771234567',
  customerName: 'Ursa Test',
  templateName: 'order_confirm_auto_schedule',
  templateLanguage: 'fr',
  variables: [
    { name: 'greeting', value: 'Bonjour' },
    { name: 'name', value: 'Ursa' },
    { name: 'order_no', value: '#1136' },
    { name: 'amount', value: '4500' }
  ],
  providerMessageId: 'wamid.TEST123'
};

const buildApiMock = (overrides: { contacts?: unknown[]; conversations?: unknown[] } = {}) => {
  const get = jest.fn(async (url: string) => {
    if (url === '/contacts/search') {
      return { data: { payload: overrides.contacts ?? [] } };
    }
    if (url.endsWith('/conversations')) {
      return { data: { payload: overrides.conversations ?? [] } };
    }
    throw new Error(`Unexpected GET ${url}`);
  });

  const post = jest.fn(async (url: string, _body?: unknown) => {
    if (url === '/contacts') {
      return { data: { payload: { contact: { id: 42 } } } };
    }
    if (url === '/conversations') {
      return { data: { id: 7 } };
    }
    return { data: {} };
  });

  mockedCreate.mockReturnValue({ get, post } as unknown as ReturnType<typeof axios.create>);
  return { get, post };
};

describe('ChatwootOutboundMirrorService', () => {
  const originalChatwoot = { ...config.chatwoot };

  beforeEach(() => {
    jest.clearAllMocks();
    ChatwootOutboundMirrorService.resetTemplateCache();
    Object.assign(config.chatwoot, {
      url: 'https://chatwoot.example.com',
      apiAccessToken: 'cw-token',
      accountId: '1',
      inboxId: '1'
    });
    mockedProvider.prototype.fetchMessageTemplates.mockResolvedValue({
      data: [
        {
          name: 'order_confirm_auto_schedule',
          language: 'fr',
          components: [{ type: 'BODY', text: templateBody }]
        }
      ]
    });
  });

  afterEach(() => {
    Object.assign(config.chatwoot, originalChatwoot);
  });

  it('is disabled when the API token or inbox id is missing', async () => {
    Object.assign(config.chatwoot, { apiAccessToken: '', inboxId: '' });

    expect(ChatwootOutboundMirrorService.isEnabled()).toBe(false);
    await expect(ChatwootOutboundMirrorService.mirrorTemplateMessage(baseInput)).resolves.toBe(false);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('refuses to mirror without a provider message id (double-send guard)', async () => {
    const { post } = buildApiMock();

    await expect(
      ChatwootOutboundMirrorService.mirrorTemplateMessage({ ...baseInput, providerMessageId: undefined })
    ).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('mirrors the rendered template into the open conversation of an existing contact', async () => {
    const { post } = buildApiMock({
      contacts: [
        {
          id: 5,
          phone_number: '+221771234567',
          contact_inboxes: [{ source_id: '221771234567', inbox: { id: 1 } }]
        }
      ],
      conversations: [
        { id: 11, inbox_id: 1, status: 'resolved' },
        { id: 12, inbox_id: 1, status: 'open' }
      ]
    });

    await expect(ChatwootOutboundMirrorService.mirrorTemplateMessage(baseInput)).resolves.toBe(true);

    expect(post).toHaveBeenCalledWith('/conversations/12/messages', {
      content: '👋Bonjour Ursa !\nVotre commande #1136 chez Alkima a bien été reçue. ✅\nMontant : 4500 XOF',
      message_type: 'outgoing',
      source_id: 'wamid.TEST123'
    });
  });

  it('creates the contact and the conversation when none exist yet', async () => {
    const { post } = buildApiMock({ contacts: [], conversations: [] });

    await expect(ChatwootOutboundMirrorService.mirrorTemplateMessage(baseInput)).resolves.toBe(true);

    expect(post).toHaveBeenCalledWith('/contacts', {
      inbox_id: 1,
      name: 'Ursa Test',
      phone_number: '+221771234567'
    });
    expect(post).toHaveBeenCalledWith('/conversations', { inbox_id: 1, contact_id: 42 });
    expect(post).toHaveBeenCalledWith('/conversations/7/messages', expect.objectContaining({ source_id: 'wamid.TEST123' }));
  });

  it('falls back to a variable summary when Meta templates cannot be fetched', async () => {
    mockedProvider.prototype.fetchMessageTemplates.mockRejectedValue(new Error('meta down'));
    const { post } = buildApiMock({
      contacts: [
        { id: 5, phone_number: '+221771234567', contact_inboxes: [{ inbox: { id: 1 } }] }
      ],
      conversations: [{ id: 12, inbox_id: 1, status: 'open' }]
    });

    await expect(ChatwootOutboundMirrorService.mirrorTemplateMessage(baseInput)).resolves.toBe(true);

    const messageCall = post.mock.calls.find(([url]) => url === '/conversations/12/messages');
    expect(messageCall?.[1]).toMatchObject({
      content: expect.stringContaining('order_no: #1136'),
      source_id: 'wamid.TEST123'
    });
  });

  it('never throws when Chatwoot is unreachable', async () => {
    const get = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    mockedCreate.mockReturnValue({ get, post: jest.fn() } as unknown as ReturnType<typeof axios.create>);

    await expect(ChatwootOutboundMirrorService.mirrorTemplateMessage(baseInput)).resolves.toBe(false);
  });
});
