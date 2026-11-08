import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/store.js';

const input = { to: '+972501234567', body: 'Field inspection at 08:00.' };

test('disk persistence retains messages, statuses and idempotency keys across restart', t => {
  const folder = mkdtempSync(join(tmpdir(), 'sms-store-'));
  let store: MessageStore | undefined;
  t.after(() => {
    // Windows requires the SQLite handle to close before its files can be removed.
    store?.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const path = join(folder, 'nested', 'messages.sqlite');
  store = new MessageStore(path);
  const id = store.create(input, 'durable-key').message.id;
  store.claimNext();
  store.transition(id, 'sending', 'accepted', 'provider-123', null);
  store.close();
  store = undefined;
  store = new MessageStore(path);
  assert.equal(store.get(id)?.status, 'accepted');
  assert.equal(store.get(id)?.providerId, 'provider-123');
  assert.equal(store.create(input, 'durable-key').message.id, id);
  assert.equal(store.recoverInterrupted(), 0);
});

test('recovery marks only interrupted sends unknown and leaves queued work available', t => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const first = store.create(input, null).message;
  store.claimNext();
  const queued = store.create(input, null).message;
  assert.equal(store.recoverInterrupted(), 1);
  assert.equal(store.get(first.id)?.status, 'unknown');
  assert.equal(store.get(first.id)?.errorCode, 'INTERRUPTED_SEND');
  assert.equal(store.claimNext()?.id, queued.id);
});

test('terminal states cannot be moved back to queued or overwritten', t => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const { id } = store.create(input, null).message;
  store.claimNext();
  store.transition(id, 'sending', 'unknown', null, 'SEND_OUTCOME_UNCERTAIN');
  assert.throws(() => store.transition(id, 'unknown', 'queued', null, null), /Invalid message transition/);
  assert.throws(() => store.transition(id, 'sending', 'accepted', 'late', null), /no longer sending/);
  assert.equal(store.get(id)?.status, 'unknown');
});
