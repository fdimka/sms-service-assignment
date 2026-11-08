import Fastify, { LogController } from 'fastify';
import { HttpError, parseEmployeeContact, parseIdempotencyKey, parseListQuery, parseMessage, parseMessageId } from './domain.js';
import { MessageStore } from './store.js';
import { registerUi } from './ui.js';

export function buildApp(store: MessageStore, logging = false) {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: logging ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.idempotency-key'] } : false,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const httpError = error as { statusCode?: number; code?: string };
    if (httpError.statusCode && httpError.statusCode >= 400 && httpError.statusCode < 500) {
      return reply.code(httpError.statusCode).send({
        error: { code: httpError.code ?? 'BAD_REQUEST', message: 'Invalid request format, media type or size.' },
      });
    }
    // Keep exception text and request data out of logs; SQLite errors can include values.
    request.log.error({ requestId: request.id, code: 'INTERNAL_ERROR' }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  });

  app.get('/health', async () => {
    store.checkHealth();
    return { status: 'ok', database: 'ok', provider: 'not_checked' };
  });

  registerUi(app);

  app.post('/employees', async (request, reply) => {
    const result = store.addEmployeeContact(parseEmployeeContact(request.body));
    return reply.code(result.contactCreated ? 201 : 200).send(result);
  });

  app.get('/employees', async request => {
    const input = request.query as Record<string, unknown>;
    if ('status' in input) throw new HttpError(400, 'INVALID_INPUT', 'Employee queries support only limit and offset.');
    return store.listEmployees(parseListQuery(input));
  });

  app.post('/messages', async (request, reply) => {
    const input = parseMessage(request.body);
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    const { message, created } = store.create(input, key);
    request.log.info({ messageId: message.id, created }, 'Message submission stored');
    return reply.code(202).header('location', `/messages/${message.id}`).send({ id: message.id, status: message.status });
  });

  app.get<{ Params: { id: string } }>('/messages/:id', async request => {
    const message = store.get(parseMessageId(request.params.id));
    if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'No message exists with this ID.');
    return message;
  });

  app.get('/messages', async request => {
    const query = parseListQuery(request.query as Record<string, unknown>);
    return { items: store.list(query), limit: query.limit, offset: query.offset };
  });

  return app;
}
