import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { HttpError, parseIdempotencyKey, parseMessage } from './domain.js';

interface MockRecord { id: string; to: string; body: string; createdAt: number }

// A development substitute only. Its receipts intentionally do not survive a restart.
export function buildMockProvider(deliveryDelayMs = 750) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const records = new Map<string, MockRecord>();
  const keys = new Map<string, string>();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ code: error.code });
    const code = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(code).send({ code: 'MOCK_ERROR' });
  });

  app.post('/sms', async (request, reply) => {
    const input = parseMessage(request.body);
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!key) throw new HttpError(400, 'KEY_REQUIRED', 'Idempotency-Key is required.');
    const existingId = keys.get(key);
    if (existingId) {
      const existing = records.get(existingId)!;
      if (existing.to !== input.to || existing.body !== input.body) {
        return reply.code(409).send({ code: 'IDEMPOTENCY_CONFLICT' });
      }
      return reply.code(202).send({ id: existing.id, status: 'accepted' });
    }
    if (input.to.endsWith('000')) return reply.code(422).send({ code: 'REJECTED' });
    const record = { ...input, id: randomUUID(), createdAt: Date.now() };
    records.set(record.id, record);
    keys.set(key, record.id);
    return reply.code(202).send({ id: record.id, status: 'accepted' });
  });

  app.get<{ Params: { id: string } }>('/sms/:id', async (request, reply) => {
    const record = records.get(request.params.id);
    if (!record) return reply.code(404).send({ code: 'NOT_FOUND' });
    const pending = record.to.endsWith('002') || Date.now() - record.createdAt < deliveryDelayMs;
    return { id: record.id, status: pending ? 'accepted' : record.to.endsWith('001') ? 'failed' : 'delivered' };
  });

  return app;
}
