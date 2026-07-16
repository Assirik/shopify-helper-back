import axios from 'axios';
import { MetaWhatsAppProvider } from '../../providers/metaWhatsApp.provider';
import { TemplateVariable } from '../../providers/messaging.provider';
import config from '../config/env.config';
import log from '../logger/logger';

const MIRROR_TIMEOUT_MS = 5000;
const TEMPLATE_CACHE_TTL_MS = 10 * 60 * 1000;

export interface OutboundMirrorInput {
  // Customer phone in E.164 (+221...), as sent to Meta.
  to: string;
  customerName: string;
  templateName: string;
  templateLanguage: string;
  variables: TemplateVariable[];
  // Meta wamid of the sent message. Mandatory: Chatwoot only skips re-sending an
  // outgoing message when it carries a provider source_id.
  providerMessageId?: string;
}

interface MetaTemplate {
  name?: string;
  language?: string;
  components?: Array<{ type?: string; text?: string }>;
}

interface ChatwootContact {
  id: number;
  phone_number?: string;
  contact_inboxes?: Array<{ source_id?: string; inbox?: { id?: number } }>;
}

let templateBodyCache: { fetchedAt: number; bodies: Map<string, string> } | null = null;

// Mirrors the templates the backend sends via Meta into the matching Chatwoot
// conversation, so agents see the full thread (the confirmation request that a
// customer's "Je confirme" answers, etc.). Chatwoot is display-only: the message is
// created with the Meta source_id, which Chatwoot treats as "already delivered by
// the provider" and never re-sends. Like the inbound forward, this must NEVER fail
// the caller: every error is logged and swallowed.
export class ChatwootOutboundMirrorService {
  public static isEnabled(): boolean {
    return Boolean(config.chatwoot.url && config.chatwoot.apiAccessToken && config.chatwoot.inboxId);
  }

  public static resetTemplateCache(): void {
    templateBodyCache = null;
  }

  public static async mirrorTemplateMessage(input: OutboundMirrorInput): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    // Without the wamid Chatwoot would treat the message as agent-authored and send
    // it to the customer a second time — never mirror in that case.
    if (!input.providerMessageId) {
      log.warn({ templateName: input.templateName }, 'Skipping Chatwoot mirror: no provider message id');
      return false;
    }

    try {
      const content = await this.renderTemplateText(input);
      const contactId = await this.findOrCreateContact(input);
      const conversationId = await this.findOrCreateConversation(contactId);

      await this.api().post(`/conversations/${conversationId}/messages`, {
        content,
        message_type: 'outgoing',
        source_id: input.providerMessageId
      });

      return true;
    } catch (err) {
      log.error({ err, to: input.to, templateName: input.templateName }, 'Failed to mirror WhatsApp template to Chatwoot');
      return false;
    }
  }

  private static api() {
    return axios.create({
      baseURL: `${config.chatwoot.url}/api/v1/accounts/${config.chatwoot.accountId}`,
      headers: { api_access_token: config.chatwoot.apiAccessToken },
      timeout: MIRROR_TIMEOUT_MS
    });
  }

  // Chatwoot's WhatsApp contact source_id is the E.164 number without the "+".
  private static toSourceId(phoneE164: string) {
    return phoneE164.replace(/^\+/, '');
  }

  /**
   * Reproduces the text the customer received: fetches the template bodies from Meta
   * (cached in memory) and substitutes the named variables. Falls back to a plain
   * "name — variables" summary so the agent always gets the order context, even when
   * Meta is unreachable.
   */
  private static async renderTemplateText(input: OutboundMirrorInput): Promise<string> {
    const body = await this.getTemplateBody(input.templateName, input.templateLanguage);

    if (!body) {
      const summary = input.variables.map((variable) => `${variable.name}: ${variable.value}`).join('\n');
      return `[${input.templateName}]\n${summary}`;
    }

    return input.variables.reduce(
      (text, variable) => text.split(`{{${variable.name}}}`).join(variable.value),
      body
    );
  }

  private static async getTemplateBody(templateName: string, language: string): Promise<string | null> {
    const now = Date.now();

    if (!templateBodyCache || now - templateBodyCache.fetchedAt > TEMPLATE_CACHE_TTL_MS) {
      try {
        const response = (await new MetaWhatsAppProvider().fetchMessageTemplates()) as { data?: MetaTemplate[] };
        const bodies = new Map<string, string>();

        for (const template of response?.data || []) {
          const bodyComponent = template.components?.find((component) => component.type === 'BODY');

          if (template.name && bodyComponent?.text) {
            bodies.set(`${template.name}:${template.language}`, bodyComponent.text);
          }
        }

        templateBodyCache = { fetchedAt: now, bodies };
      } catch (err) {
        log.warn({ err }, 'Could not fetch Meta templates for Chatwoot mirror, using summary fallback');
        return null;
      }
    }

    return templateBodyCache.bodies.get(`${templateName}:${language}`) || null;
  }

  private static async findOrCreateContact(input: OutboundMirrorInput): Promise<number> {
    const search = await this.api().get('/contacts/search', { params: { q: this.toSourceId(input.to) } });
    const contacts: ChatwootContact[] = search.data?.payload || [];
    const existing = contacts.find((contact) => contact.phone_number === input.to);

    if (existing) {
      const inboxId = Number(config.chatwoot.inboxId);
      const hasInbox = (existing.contact_inboxes || []).some((ci) => ci.inbox?.id === inboxId);

      if (!hasInbox) {
        await this.api().post(`/contacts/${existing.id}/contact_inboxes`, {
          inbox_id: inboxId,
          source_id: this.toSourceId(input.to)
        });
      }

      return existing.id;
    }

    const created = await this.api().post('/contacts', {
      inbox_id: Number(config.chatwoot.inboxId),
      name: input.customerName,
      phone_number: input.to
    });

    const contactId = created.data?.payload?.contact?.id;

    if (!contactId) {
      throw new Error('Chatwoot contact creation returned no id');
    }

    return contactId;
  }

  private static async findOrCreateConversation(contactId: number): Promise<number> {
    const inboxId = Number(config.chatwoot.inboxId);
    const response = await this.api().get(`/contacts/${contactId}/conversations`);
    const conversations: Array<{ id: number; inbox_id?: number; status?: string }> = response.data?.payload || [];
    const inInbox = conversations.filter((conversation) => conversation.inbox_id === inboxId);
    // Prefer the open conversation (where an incoming reply would land); otherwise
    // reuse the latest one rather than splitting the customer history.
    const target = inInbox.find((conversation) => conversation.status !== 'resolved') || inInbox[0];

    if (target) {
      return target.id;
    }

    const created = await this.api().post('/conversations', {
      inbox_id: inboxId,
      contact_id: contactId
    });

    const conversationId = created.data?.id;

    if (!conversationId) {
      throw new Error('Chatwoot conversation creation returned no id');
    }

    return conversationId;
  }
}
