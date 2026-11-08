import { buildApp } from './app.js';
import { buildMockProvider } from './mock-provider.js';
import { HttpSmsProvider } from './provider.js';
import { MessageStore } from './store.js';
import { MessageWorker } from './worker.js';
import { parseArgs } from 'node:util';

function positiveInteger(name: string, fallback: number, max: number, override?: string): number {
  const raw = override ?? process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`Invalid ${name}`);
  return Number(raw);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    host: { type: 'string' }, port: { type: 'string' }, strictPort: { type: 'boolean' },
  } });
  const port = positiveInteger('PORT', 3000, 65535, values.port);
  const timeout = positiveInteger('PROVIDER_TIMEOUT_MS', 2000, 30_000);
  const interval = positiveInteger('WORKER_INTERVAL_MS', 250, 60_000);
  const mockPort = positiveInteger('MOCK_PROVIDER_PORT', 4010, 65535);
  const mock = process.env.SMS_PROVIDER_URL ? undefined : buildMockProvider();
  // Validate configuration before opening the database or listeners.
  const provider = new HttpSmsProvider(process.env.SMS_PROVIDER_URL || `http://127.0.0.1:${mockPort}`, timeout);
  const store = new MessageStore(process.env.DATABASE_PATH || './data/messages.sqlite');
  const app = buildApp(store, true);
  const worker = new MessageWorker(store, provider, app.log);
  let stopping = false;

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const closeApi = app.close();
    await worker.stop();
    await closeApi;
    await mock?.close();
    store.close();
  }

  try {
    if (mock) await mock.listen({ host: '127.0.0.1', port: mockPort });
    await app.listen({ host: values.host ?? '127.0.0.1', port });
    worker.start(interval);
    app.log.info({ providerMode: mock ? 'bundled_mock' : 'external' }, 'SMS service ready');
  } catch (error) {
    await shutdown();
    throw error;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown().catch(() => { process.exitCode = 1; });
    });
  }
}

void main().catch(error => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'STARTUP_FAILED';
  console.error(`SMS service could not start (${code}). Check Node version, ports, provider URL and database path.`);
  process.exitCode = 1;
});
