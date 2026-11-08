import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const servers = [createServer(), createServer()];
const ports = [];
for (const server of servers) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ports.push(server.address().port);
}
await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));

const directory = await mkdtemp(join(tmpdir(), 'sms-smoke-'));
const baseUrl = `http://127.0.0.1:${ports[0]}`;
let child;
let output = '';

async function start() {
  output = '';
  child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(ports[0]), MOCK_PROVIDER_PORT: String(ports[1]),
      DATABASE_PATH: join(directory, 'messages.sqlite'), SMS_PROVIDER_URL: '',
      WORKER_INTERVAL_MS: '50', PROVIDER_TIMEOUT_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let launchError;
  child.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch { /* Listener is still starting. */ }
    await delay(50);
  }
  throw new Error(`Server did not become ready: ${output}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exit; } finally { clearTimeout(killTimer); }
}

async function submit(to, key, body = 'The irrigation check is complete.', employee) {
  const response = await fetch(`${baseUrl}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ to, body, employee }),
  });
  assert.equal(response.status, 202);
  return response.json();
}

async function read(id) {
  const response = await fetch(`${baseUrl}/messages/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function awaitStatus(id, expected) {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    const message = await read(id);
    last = { status: message.status, errorCode: message.errorCode };
    if (message.status === expected) return message;
    await delay(50);
  }
  throw new Error(`Message ${id} did not reach ${expected}; last state ${JSON.stringify(last)}.\n${output}`);
}

try {
  await start();
  const home = await fetch(baseUrl);
  assert.match(await home.text(), /Employee SMS/);
  const employee = { firstName: 'Dana', lastName: 'Levi', address: '12 Demo Road' };
  for (const contact of [
    { ...employee, phone: '+972501234567' }, { ...employee, phone: '+972501234568' },
    { ...employee, firstName: 'Noam', phone: '+972501234567' },
  ]) {
    const response = await fetch(`${baseUrl}/employees`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(contact) });
    assert.equal(response.status, 201);
  }
  const directory = await fetch(`${baseUrl}/employees`);
  const listed = await directory.json();
  assert.equal(listed.total, 2);
  assert.equal(listed.items.find(item => item.firstName === 'Dana').phones.length, 2);
  const sent = await submit('+972501234567', 'smoke-success');
  assert.equal((await submit('+972501234567', 'smoke-success')).id, sent.id);
  const rejected = await submit('+972501230000', 'smoke-rejected');
  const undelivered = await submit('+972501230001', 'smoke-undelivered');
  const pending = await submit('+972501230002', 'smoke-pending');
  const linked = await submit('+972501234567', 'smoke-linked', 'Employee-specific SMS.', employee);
  await awaitStatus(sent.id, 'delivered');
  assert.equal((await awaitStatus(rejected.id, 'failed')).errorCode, 'PROVIDER_REJECTED');
  assert.equal((await awaitStatus(undelivered.id, 'failed')).errorCode, 'DELIVERY_FAILED');
  await awaitStatus(pending.id, 'accepted');
  assert.deepEqual((await awaitStatus(linked.id, 'delivered')).employee, employee);
  const filtered = await fetch(`${baseUrl}/messages?status=failed`);
  assert.equal((await filtered.json()).items.length, 2);

  await stop();
  await start();
  assert.equal((await read(sent.id)).status, 'delivered');
  assert.equal((await submit('+972501234567', 'smoke-success')).id, sent.id);
  assert.equal((await submit('+972501234567', 'smoke-linked', 'Employee-specific SMS.', employee)).id, linked.id);
  assert.deepEqual((await read(linked.id)).employee, employee);
  assert.equal((await (await fetch(`${baseUrl}/employees`)).json()).total, 2);
  // The substitute provider lost its in-memory records; do not invent a delivery receipt.
  await awaitStatus(pending.id, 'unknown');
  const history = await fetch(`${baseUrl}/messages`);
  assert.equal((await history.json()).items.length, 5);
  console.log('SMOKE PASS: UI assets, employee grouping/shared phones, sends, receipts, filtering, idempotency and restart persistence.');
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
