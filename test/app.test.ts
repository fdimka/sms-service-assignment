import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { MessageStore } from '../src/store.js';

const payload = { to: '+972501234567', body: 'Water the north field.' };

function fixture(t: TestContext) {
  const store = new MessageStore(':memory:');
  const app = buildApp(store);
  t.after(async () => { await app.close(); store.close(); });
  return { app, store };
}

test('POST stores a queued request and GET exposes its status without private keys', async t => {
  const { app } = fixture(t);
  const response = await app.inject({ method: 'POST', url: '/messages', payload,
    headers: { 'idempotency-key': 'one' } });
  assert.equal(response.statusCode, 202);
  const { id, status } = response.json();
  assert.equal(status, 'queued');
  assert.equal(response.headers.location, `/messages/${id}`);
  const fetched = await app.inject(`/messages/${id}`);
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().body, payload.body);
  assert.equal(fetched.json().providerId, null);
  assert.equal(fetched.json().idempotencyKey, undefined);
});

test('concurrent duplicate submissions produce one message; changed content conflicts', async t => {
  const { app } = fixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, () => app.inject({
    method: 'POST', url: '/messages', payload, headers: { 'idempotency-key': 'same-click' },
  })));
  assert.ok(responses.every(response => response.statusCode === 202));
  assert.equal(new Set(responses.map(response => response.json().id)).size, 1);
  const conflict = await app.inject({ method: 'POST', url: '/messages',
    payload: { ...payload, body: 'Changed' }, headers: { 'idempotency-key': 'same-click' } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await app.inject('/messages')).json().items.length, 1);
});

test('identical messages without a key are separate sends, even to the same phone', async t => {
  const { app } = fixture(t);
  const first = await app.inject({ method: 'POST', url: '/messages', payload });
  const second = await app.inject({ method: 'POST', url: '/messages', payload });
  assert.notEqual(first.json().id, second.json().id);
});

test('validation and malformed JSON return 400 without saving messages', async t => {
  const { app } = fixture(t);
  for (const invalid of [{ to: '0501', body: 'Hi' }, { ...payload, body: ' ' }, { ...payload, extra: true }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/messages', payload: invalid })).statusCode, 400);
  }
  const malformed = await app.inject({ method: 'POST', url: '/messages', payload: '{',
    headers: { 'content-type': 'application/json' } });
  assert.equal(malformed.statusCode, 400);
  assert.equal((await app.inject('/messages')).json().items.length, 0);
});

test('request body size is bounded and media type is checked', async t => {
  const { app } = fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/messages',
    payload: { ...payload, body: 'a'.repeat(17000) } })).statusCode, 413);
  assert.equal((await app.inject({ method: 'POST', url: '/messages', payload: 'hi',
    headers: { 'content-type': 'application/octet-stream' } })).statusCode, 415);
});

test('list filters, ordering and pagination use persisted state', async t => {
  const { app, store } = fixture(t);
  const first = store.create(payload, null).message;
  store.claimNext();
  store.transition(first.id, 'sending', 'failed', null, 'PROVIDER_REJECTED');
  store.create({ ...payload, body: 'Another' }, null);
  store.create({ ...payload, body: 'Third' }, null);
  const failed = (await app.inject('/messages?status=failed')).json();
  assert.equal(failed.items.length, 1);
  assert.equal(failed.items[0].id, first.id);
  const all = (await app.inject('/messages')).json().items;
  const page = (await app.inject('/messages?limit=1&offset=1')).json();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, all[1].id);
  for (const query of ['status=bogus', 'limit=101', 'status=failed&status=queued', 'limit=1&limit=2', 'foo=bar']) {
    assert.equal((await app.inject(`/messages?${query}`)).statusCode, 400);
  }
});

test('unknown UUID returns 404, malformed ID returns 400, database health is separate', async t => {
  const { app } = fixture(t);
  assert.equal((await app.inject(`/messages/${randomUUID()}`)).statusCode, 404);
  assert.equal((await app.inject('/messages/not-an-id')).statusCode, 400);
  assert.deepEqual((await app.inject('/health')).json(), {
    status: 'ok', database: 'ok', provider: 'not_checked',
  });
});
