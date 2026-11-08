import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { parseEmployeeContact, parseEmployeeIdentity } from '../src/domain.js';
import { MessageStore } from '../src/store.js';

const employee = { firstName: 'Dana', lastName: 'Levi', address: '12 Field Road' };
const phone = '+972501234567';

function fixture(t: TestContext) {
  const store = new MessageStore(':memory:');
  const app = buildApp(store);
  t.after(async () => { await app.close(); store.close(); });
  const add = (payload: unknown) => app.inject({ method: 'POST', url: '/employees', payload: payload as object });
  return { app, store, add };
}

test('employee identity normalizes Unicode and whitespace, with exact case-sensitive values', () => {
  assert.deepEqual(parseEmployeeIdentity({ firstName: '  Jose\u0301 ', lastName: ' Levi ', address: ' 12\n Field  Road ' }), {
    firstName: 'José', lastName: 'Levi', address: '12 Field Road',
  });
  assert.equal(parseEmployeeIdentity({ ...employee, firstName: 'dana' }).firstName, 'dana');
  assert.equal(parseEmployeeContact({ ...employee, firstName: 'דנה', phone }).firstName, 'דנה');
});

test('employee contact validation rejects missing identity fields, long values and extra identifiers', () => {
  for (const input of [null, [], { ...employee }, { ...employee, phone: '0501234567' },
    { ...employee, phone, firstName: ' ' }, { ...employee, phone, address: 'a'.repeat(301) },
    { ...employee, phone, firstName: 'a'.repeat(101) }, { ...employee, phone, employeeNumber: '123' }]) {
    assert.throws(() => parseEmployeeContact(input));
  }
});

test('repeated employee entries group by identity and retain several distinct phone numbers', async t => {
  const { app, add } = fixture(t);
  assert.equal((await add({ ...employee, phone })).statusCode, 201);
  assert.equal((await add({ ...employee, phone: '+972501234568' })).statusCode, 201);
  const duplicate = await add({ ...employee, firstName: ' Dana ', phone });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().contactCreated, false);
  const result = (await app.inject('/employees')).json();
  assert.equal(result.total, 1);
  assert.deepEqual(result.items, [{ ...employee, phones: [phone, '+972501234568'] }]);
  assert.equal('id' in result.items[0], false);
  assert.equal('employeeNumber' in result.items[0], false);
});

test('shared phone numbers do not merge employees, including identical names at different addresses', async t => {
  const { app, add } = fixture(t);
  await add({ ...employee, phone });
  await add({ ...employee, address: '13 Field Road', phone });
  await add({ ...employee, firstName: 'Noam', phone });
  const result = (await app.inject('/employees')).json();
  assert.equal(result.total, 3);
  assert.ok(result.items.every((item: { phones: string[] }) => item.phones[0] === phone));
});

test('directory pagination is bounded and rejects unsupported or repeated parameters', async t => {
  const { app, add } = fixture(t);
  await add({ ...employee, phone });
  await add({ ...employee, firstName: 'Noam', phone });
  const result = (await app.inject('/employees?limit=1&offset=1')).json();
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.offset, 1);
  for (const query of ['limit=101', 'status=queued', 'foo=bar', 'offset=-1', 'limit=1&limit=2']) {
    assert.equal((await app.inject(`/employees?${query}`)).statusCode, 400);
  }
});

test('invalid contact requests leave no partial employee records', async t => {
  const { app, add } = fixture(t);
  assert.equal((await add({ ...employee, phone: 'bad' })).statusCode, 400);
  assert.equal((await app.inject('/employees')).json().total, 0);
});

test('employee-aware send validates membership and returns the employee identity in the log', async t => {
  const { app, add } = fixture(t);
  await add({ ...employee, phone });
  const result = await app.inject({ method: 'POST', url: '/messages',
    payload: { to: phone, body: 'Inspection complete.', employee } });
  assert.equal(result.statusCode, 202);
  const message = (await app.inject(`/messages/${result.json().id}`)).json();
  assert.deepEqual(message.employee, employee);
  const list = (await app.inject('/messages')).json().items;
  assert.deepEqual(list[0].employee, employee);
  const wrongPhone = await app.inject({ method: 'POST', url: '/messages',
    payload: { to: '+972501234568', body: 'Hello', employee } });
  assert.equal(wrongPhone.statusCode, 400);
  assert.equal(wrongPhone.json().error.code, 'EMPLOYEE_CONTACT_NOT_FOUND');
  const wrongEmployee = await app.inject({ method: 'POST', url: '/messages',
    payload: { to: phone, body: 'Hello', employee: { ...employee, address: 'Other address' } } });
  assert.equal(wrongEmployee.statusCode, 400);
  assert.equal((await app.inject('/messages')).json().items.length, 1);
});

test('idempotency includes employee identity even when two employees share phone and text', async t => {
  const { app, add } = fixture(t);
  const other = { ...employee, firstName: 'Noam' };
  await add({ ...employee, phone });
  await add({ ...other, phone });
  const send = (person: typeof employee) => app.inject({ method: 'POST', url: '/messages',
    payload: { to: phone, body: 'Hello', employee: person }, headers: { 'idempotency-key': 'shared-phone' } });
  const first = await send(employee);
  const replay = await send({ ...employee, firstName: ' Dana ' });
  assert.equal(replay.statusCode, 202);
  assert.equal(replay.json().id, first.json().id);
  assert.equal((await send(other)).statusCode, 409);
});

test('phone-only API sends remain unassigned when a phone belongs to several employees', async t => {
  const { app, add } = fixture(t);
  await add({ ...employee, phone });
  await add({ ...employee, firstName: 'Noam', phone });
  const response = await app.inject({ method: 'POST', url: '/messages', payload: { to: phone, body: 'Direct API send' } });
  assert.equal(response.statusCode, 202);
  assert.equal((await app.inject(`/messages/${response.json().id}`)).json().employee, null);
});

test('directory and employee-linked history survive a database restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sms-employees-'));
  let store: MessageStore | undefined;
  t.after(() => {
    store?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const path = join(directory, 'messages.sqlite');
  store = new MessageStore(path);
  store.addEmployeeContact({ ...employee, phone });
  store.addEmployeeContact({ ...employee, phone: '+972501234568' });
  const message = store.create({ to: phone, body: 'Hello', employee }, 'linked').message;
  store.close();
  store = undefined;
  store = new MessageStore(path);
  assert.deepEqual(store.listEmployees({ limit: 10, offset: 0 }).items[0], {
    ...employee, phones: [phone, '+972501234568'],
  });
  assert.deepEqual(store.get(message.id)?.employee, employee);
  assert.equal(store.create({ to: phone, body: 'Hello', employee }, 'linked').message.id, message.id);
});

test('upgrading the original schema preserves message content, status and retry key', t => {
  const directory = mkdtempSync(join(tmpdir(), 'sms-upgrade-'));
  const path = join(directory, 'messages.sqlite');
  let legacy: DatabaseSync | undefined;
  let store: MessageStore | undefined;
  t.after(() => {
    legacy?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, to_number TEXT NOT NULL, body TEXT NOT NULL,
    status TEXT NOT NULL, provider_id TEXT, error_code TEXT, idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_checked_at TEXT
  ) STRICT;`);
  const id = randomUUID();
  const now = new Date().toISOString();
  legacy.prepare(`INSERT INTO messages(id,to_number,body,status,idempotency_key,created_at,updated_at)
    VALUES(?,?,?,'delivered',?,?,?)`).run(id, phone, 'Old message', 'old-key', now, now);
  legacy.close();
  legacy = undefined;
  store = new MessageStore(path);
  assert.equal(store.get(id)?.status, 'delivered');
  assert.equal(store.get(id)?.body, 'Old message');
  assert.equal(store.get(id)?.employee, null);
  assert.equal(store.create({ to: phone, body: 'Old message' }, 'old-key').message.id, id);
  assert.equal(store.listEmployees({ limit: 10, offset: 0 }).total, 0);
  store.addEmployeeContact({ ...employee, phone });
  assert.equal(store.listEmployees({ limit: 10, offset: 0 }).total, 1);
});

test('browser assets are served locally with a restrictive script policy', async t => {
  const { app } = fixture(t);
  const home = await app.inject('/');
  assert.equal(home.statusCode, 200);
  assert.match(home.headers['content-type']!, /text\/html/);
  assert.match(home.body, /Employee SMS/);
  assert.match(home.headers['content-security-policy']!, /script-src 'self'/);
  for (const route of ['/app.js', '/styles.css']) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  }
});
