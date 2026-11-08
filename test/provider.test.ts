import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildMockProvider } from '../src/mock-provider.js';
import { HttpSmsProvider } from '../src/provider.js';
import { MessageStore } from '../src/store.js';
import { MessageWorker } from '../src/worker.js';

const input = { to: '+972501234567', body: 'Hello from the test.' };

test('HTTP adapter sends only contract fields and agrees with mock on receipts and idempotency', async t => {
  const mock = buildMockProvider(0);
  const url = await mock.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => mock.close());
  const adapter = new HttpSmsProvider(url);
  const storedMessage = { ...input, id: 'internal-id', status: 'sending', errorCode: null };
  const first = await adapter.send(storedMessage, 'same');
  assert.equal(first.status, 'accepted');
  const replay = await adapter.send(input, 'same');
  assert.deepEqual(replay, first);
  if (first.status !== 'accepted') return assert.fail('Expected accepted');
  assert.equal(await adapter.getStatus(first.providerId), 'delivered');
  assert.equal(await adapter.getStatus('missing'), 'unknown');
});

test('mock distinguishes immediate rejection, delivery failure and pending delivery', async t => {
  const mock = buildMockProvider(0);
  const url = await mock.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => mock.close());
  const adapter = new HttpSmsProvider(url);
  assert.deepEqual(await adapter.send({ ...input, to: '+972501230000' }, 'reject'), {
    status: 'failed', errorCode: 'PROVIDER_REJECTED',
  });
  for (const [to, expected] of [['+972501230001', 'failed'], ['+972501230002', 'accepted']] as const) {
    const result = await adapter.send({ ...input, to }, `case-${expected}`);
    if (result.status !== 'accepted') return assert.fail('Expected accepted');
    assert.equal(await adapter.getStatus(result.providerId), expected);
  }
});

test('timeout after provider acceptance does not cause a second send', async t => {
  const server = Fastify();
  let acceptedCount = 0;
  server.post('/sms', async (_request, reply) => {
    acceptedCount++;
    await delay(150);
    return reply.code(202).send({ id: 'accepted-before-timeout', status: 'accepted' });
  });
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  const store = new MessageStore(':memory:');
  const worker = new MessageWorker(store, new HttpSmsProvider(url, 50), { info() {}, warn() {}, error() {} });
  t.after(async () => { await worker.stop(); store.close(); await server.close(); });
  const { id } = store.create(input, null).message;
  await worker.tick();
  assert.equal(store.get(id)?.status, 'unknown');
  await worker.tick();
  assert.equal(acceptedCount, 1);
});

test('unexpected send statuses and malformed success payloads remain uncertain', async t => {
  const server = Fastify();
  let response: { code: number; payload: unknown } = { code: 500, payload: {} };
  server.post('/sms', async (_request, reply) => reply.code(response.code).send(response.payload));
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const adapter = new HttpSmsProvider(url);
  for (const next of [
    { code: 500, payload: {} }, { code: 429, payload: {} }, { code: 202, payload: {} },
    { code: 422, payload: { code: 'UNKNOWN_ERROR' } },
    { code: 202, payload: { id: 'x', status: 'delivered' } },
    { code: 202, payload: 'not JSON' },
  ]) {
    response = next;
    assert.equal((await adapter.send(input, 'key')).status, 'unknown');
  }
});

test('receipt errors and mismatched IDs never turn acceptance into delivery', async t => {
  const server = Fastify();
  let code = 503;
  let payload: unknown = {};
  server.get('/sms/:id', async (_request, reply) => reply.code(code).send(payload));
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  const adapter = new HttpSmsProvider(url);
  await assert.rejects(() => adapter.getStatus('one'));
  code = 200;
  for (const invalid of [{ id: 'different', status: 'delivered' }, { id: 'one', status: 'sent' }, null]) {
    payload = invalid;
    await assert.rejects(() => adapter.getStatus('one'));
  }
});
