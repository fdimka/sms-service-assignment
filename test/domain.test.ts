import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError, parseIdempotencyKey, parseListQuery, parseMessage } from '../src/domain.js';

const valid = { to: '+972501234567', body: 'Hello' };

test('validation preserves Hebrew text and counts Unicode code points, not UTF-16 units', () => {
  assert.deepEqual(parseMessage({ ...valid, body: '  שלום  ' }), { ...valid, body: '  שלום  ' });
  assert.equal(parseMessage({ ...valid, body: '🚜'.repeat(160) }).body, '🚜'.repeat(160));
  assert.throws(() => parseMessage({ ...valid, body: '🚜'.repeat(161) }), HttpError);
});

test('phone syntax accepts boundary lengths', () => {
  assert.equal(parseMessage({ ...valid, to: '+12345678' }).to, '+12345678');
  assert.equal(parseMessage({ ...valid, to: '+123456789012345' }).to, '+123456789012345');
});

for (const [name, input] of [
  ['null', null], ['array', []], ['missing body', { to: valid.to }],
  ['numeric phone', { ...valid, to: 972501234567 }],
  ['local phone', { ...valid, to: '0501234567' }],
  ['leading zero', { ...valid, to: '+012345678' }],
  ['short phone', { ...valid, to: '+1234567' }],
  ['long phone', { ...valid, to: '+1234567890123456' }],
  ['phone spacing', { ...valid, to: '+972 501234567' }],
  ['empty body', { ...valid, body: '' }], ['whitespace body', { ...valid, body: '\n \t' }],
  ['numeric body', { ...valid, body: 123 }],
  ['unexpected field', { ...valid, employeeId: '123' }],
] as const) {
  test(`validation rejects ${name}`, () => assert.throws(() => parseMessage(input), HttpError));
}

test('idempotency keys are optional, bounded and unambiguous', () => {
  assert.equal(parseIdempotencyKey(undefined), null);
  assert.equal(parseIdempotencyKey('campaign-1:recipient.2'), 'campaign-1:recipient.2');
  for (const invalid of ['', 'a'.repeat(129), 'with space', ['a', 'b']]) {
    assert.throws(() => parseIdempotencyKey(invalid), HttpError);
  }
});

test('query validation bounds pagination and rejects invalid or repeated values', () => {
  assert.deepEqual(parseListQuery({}), { limit: 50, offset: 0 });
  assert.deepEqual(parseListQuery({ status: 'unknown', limit: '100', offset: '2' }), {
    status: 'unknown', limit: 100, offset: 2,
  });
  for (const invalid of [
    { limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '-1' }, { offset: '1000001' },
    { status: 'sent' }, { status: ['failed', 'queued'] }, { filter: 'failed' },
  ]) assert.throws(() => parseListQuery(invalid), HttpError);
});
