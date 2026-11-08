import type { MessageInput } from './domain.js';

export type SendResult =
  | { status: 'accepted'; providerId: string }
  | { status: 'failed' | 'unknown'; errorCode: string };
export type ReceiptStatus = 'accepted' | 'delivered' | 'failed' | 'unknown';

export interface SmsProvider {
  send(input: MessageInput, idempotencyKey: string): Promise<SendResult>;
  getStatus(providerId: string): Promise<ReceiptStatus>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// This adapter implements our substitute contract, not an unseen vendor API.
export class HttpSmsProvider implements SmsProvider {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly timeoutMs = 2000) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('SMS_PROVIDER_URL must be an HTTP(S) URL without credentials, query or fragment.');
    }
    this.baseUrl = url.href.replace(/\/$/, '');
  }

  async send(input: MessageInput, idempotencyKey: string): Promise<SendResult> {
    try {
      const response = await fetch(`${this.baseUrl}/sms`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ to: input.to, body: input.body }),
      });
      const payload: unknown = await response.json();
      // Only a response explicitly defined as a non-accepted rejection is safe to call failed.
      if (response.status === 422 && isObject(payload) && payload.code === 'REJECTED') {
        return { status: 'failed', errorCode: 'PROVIDER_REJECTED' };
      }
      if (response.status === 202 && isObject(payload) && payload.status === 'accepted'
        && typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 200) {
        return { status: 'accepted', providerId: payload.id };
      }
      return { status: 'unknown', errorCode: 'UNEXPECTED_SEND_RESPONSE' };
    } catch {
      // A timeout can occur after the provider accepted the SMS. Do not blindly resend.
      return { status: 'unknown', errorCode: 'SEND_OUTCOME_UNCERTAIN' };
    }
  }

  async getStatus(providerId: string): Promise<ReceiptStatus> {
    const response = await fetch(`${this.baseUrl}/sms/${encodeURIComponent(providerId)}`, {
      redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return 'unknown';
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('RECEIPT_LOOKUP_FAILED');
    }
    const payload: unknown = await response.json();
    if (!isObject(payload) || payload.id !== providerId || typeof payload.status !== 'string'
      || !['accepted', 'delivered', 'failed'].includes(payload.status)) {
      throw new Error('INVALID_RECEIPT_RESPONSE');
    }
    return payload.status as ReceiptStatus;
  }
}
