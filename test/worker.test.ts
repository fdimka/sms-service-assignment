import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ReceiptStatus, SendResult, SmsProvider } from '../src/provider.js';
import { MessageStore } from '../src/store.js';
import { MessageWorker } from '../src/worker.js';

const input = { to: '+972501234567', body: 'Test message' };
const silentLog = { info() {}, warn() {}, error() {} };

class StubProvider implements SmsProvider {
  calls: string[] = [];
  sendResult: SendResult = { status: 'accepted', providerId: 'provider-1' };
  receipt: ReceiptStatus = 'accepted';
  receiptError = false;
  async send(_input: unknown, key: string): Promise<SendResult> { this.calls.push(key); return this.sendResult; }
  async getStatus(): Promise<ReceiptStatus> {
    if (this.receiptError) throw new Error('temporary failure');
    return this.receipt;
  }
}

function fixture(t: TestContext, batchSize = 10) {
  const store = new MessageStore(':memory:');
  const provider = new StubProvider();
  const worker = new MessageWorker(store, provider, silentLog, batchSize);
  t.after(async () => { await worker.stop(); store.close(); });
  return { store, provider, worker };
}

test('provider acceptance is not delivery; receipt later updates the status', async t => {
  const { store, provider, worker } = fixture(t);
  const { id } = store.create(input, null).message;
  await worker.tick();
  assert.equal(store.get(id)?.status, 'accepted');
  provider.receipt = 'delivered';
  await worker.tick();
  assert.equal(store.get(id)?.status, 'delivered');
  assert.deepEqual(provider.calls, [id]);
});

test('an explicit rejection becomes failed', async t => {
  const { store, provider, worker } = fixture(t);
  provider.sendResult = { status: 'failed', errorCode: 'PROVIDER_REJECTED' };
  const { id } = store.create(input, null).message;
  await worker.tick();
  assert.equal(store.get(id)?.status, 'failed');
  assert.equal(store.get(id)?.errorCode, 'PROVIDER_REJECTED');
});

test('an uncertain send is not retried on later cycles or key replay', async t => {
  const { store, provider, worker } = fixture(t);
  provider.sendResult = { status: 'unknown', errorCode: 'SEND_OUTCOME_UNCERTAIN' };
  const { id } = store.create(input, 'one').message;
  await worker.tick();
  assert.equal(store.create(input, 'one').message.id, id);
  await worker.tick();
  await worker.tick();
  assert.equal(store.get(id)?.status, 'unknown');
  assert.equal(provider.calls.length, 1);
});

test('unexpected adapter errors also remain unknown without a retry', async t => {
  const { store } = fixture(t);
  let calls = 0;
  const provider: SmsProvider = {
    async send() { calls++; throw new Error('socket reset'); },
    async getStatus() { return 'accepted'; },
  };
  const worker = new MessageWorker(store, provider, silentLog);
  const { id } = store.create(input, null).message;
  await worker.tick();
  await worker.tick();
  assert.equal(store.get(id)?.status, 'unknown');
  assert.equal(calls, 1);
});

test('transient receipt failures preserve accepted status and retry only the read', async t => {
  const { store, provider, worker } = fixture(t);
  provider.receiptError = true;
  const { id } = store.create(input, null).message;
  await worker.tick();
  assert.equal(store.get(id)?.status, 'accepted');
  provider.receiptError = false;
  provider.receipt = 'failed';
  await worker.tick();
  assert.equal(store.get(id)?.status, 'failed');
  assert.equal(store.get(id)?.errorCode, 'DELIVERY_FAILED');
  assert.equal(provider.calls.length, 1);
});

test('missing provider receipt becomes unknown, never delivered', async t => {
  const { store, provider, worker } = fixture(t);
  provider.receipt = 'unknown';
  const { id } = store.create(input, null).message;
  await worker.tick();
  assert.equal(store.get(id)?.status, 'unknown');
  assert.equal(store.get(id)?.errorCode, 'RECEIPT_NOT_FOUND');
});

test('overlapping cycles share one in-flight send; stop waits for it', async t => {
  const { store } = fixture(t);
  let finish!: (value: SendResult) => void;
  let calls = 0;
  const provider: SmsProvider = {
    send: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    async getStatus() { return 'accepted'; },
  };
  const worker = new MessageWorker(store, provider, silentLog);
  const { id } = store.create(input, null).message;
  const first = worker.tick();
  const second = worker.tick();
  assert.equal(first, second);
  let stopped = false;
  const stop = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish({ status: 'accepted', providerId: 'one' });
  await Promise.all([first, second, stop]);
  assert.equal(calls, 1);
  assert.equal(store.get(id)?.status, 'accepted');
  await worker.tick();
  assert.equal(calls, 1);
});

test('polling failures do not starve other accepted messages', async t => {
  const { store, provider, worker } = fixture(t, 1);
  const first = store.create(input, null).message;
  store.claimNext();
  store.transition(first.id, 'sending', 'accepted', 'provider-first', null);
  const second = store.create(input, null).message;
  store.claimNext();
  store.transition(second.id, 'sending', 'accepted', 'provider-second', null);
  provider.receiptError = true;
  const initial = store.awaitingReceipts(1)[0]!.id;
  await worker.tick();
  const next = store.awaitingReceipts(1)[0]!.id;
  assert.notEqual(initial, next);
});

test('startup recovers interrupted sends without dispatching them again', async t => {
  const { store, worker, provider } = fixture(t);
  const { id } = store.create(input, null).message;
  store.claimNext();
  worker.start(60_000);
  assert.equal(store.get(id)?.status, 'unknown');
  await worker.tick();
  assert.equal(provider.calls.length, 0);
});
