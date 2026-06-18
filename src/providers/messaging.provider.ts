export interface OrderConfirmationInput {
  orderId: string;
  to: string;
  templateName: string;
  templateLanguage: string;
  buttonPayload: string;
  variables: {
    greeting: string;
    customerName: string;
    orderName: string;
    itemName: string;
    amount: string;
    quantity: string;
    address: string;
    shippingNote: string;
    paymentMethod: string;
  };
}

export interface ProviderResult {
  providerMessageId?: string;
  response: unknown;
}

export interface MessagingProvider {
  sendOrderConfirmation(input: OrderConfirmationInput): Promise<ProviderResult>;
}

export class ProviderError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}
