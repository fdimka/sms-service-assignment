import type { FastifyBaseLogger } from 'fastify';
import type { SmsProvider } from './provider.js';
import { MessageStore } from './store.js';

type WorkerLog = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export class MessageWorker {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;

  constructor(
    private readonly store: MessageStore,
    private readonly provider: SmsProvider,
    private readonly log: WorkerLog,
    private readonly pollBatchSize = 10,
  ) {}

  start(intervalMs: number): void {
    if (this.timer || this.stopping) throw new Error('Worker already started or stopped.');
    const recovered = this.store.recoverInterrupted();
    if (recovered) this.log.warn({ count: recovered }, 'Interrupted sends marked unknown');
    this.timer = setInterval(() => {
      void this.tick().catch(() => this.log.error({ code: 'WORKER_TICK_FAILED' }, 'Worker cycle failed'));
    }, intervalMs);
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopping) return Promise.resolve();
    this.running = this.runCycle().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async runCycle(): Promise<void> {
    const message = this.store.claimNext();
    if (message) {
      // If this process dies after the claim, startup recovery will expose the uncertainty.
      // An unexpected adapter throw has the same ambiguity as an HTTP timeout.
      const result = await this.provider.send({ to: message.to, body: message.body }, message.id).catch(() => ({
        status: 'unknown' as const, errorCode: 'SEND_OUTCOME_UNCERTAIN',
      }));
      const providerId = result.status === 'accepted' ? result.providerId : null;
      const errorCode = result.status === 'accepted' ? null : result.errorCode;
      this.store.transition(message.id, 'sending', result.status, providerId, errorCode);
      const event = { messageId: message.id, status: result.status, errorCode };
      if (result.status === 'accepted') this.log.info(event, 'Provider accepted message');
      else this.log.warn(event, 'Send did not establish acceptance');
    }

    for (const pending of this.store.awaitingReceipts(this.pollBatchSize)) {
      let receipt;
      try {
        receipt = await this.provider.getStatus(pending.providerId!);
      } catch {
        this.store.recordReceiptCheck(pending.id);
        this.log.warn({ messageId: pending.id, code: 'RECEIPT_LOOKUP_FAILED' }, 'Will retry receipt lookup');
        continue;
      }
      if (receipt !== 'accepted') {
        const errorCode = receipt === 'failed' ? 'DELIVERY_FAILED' : receipt === 'unknown' ? 'RECEIPT_NOT_FOUND' : null;
        this.store.transition(pending.id, 'accepted', receipt, pending.providerId, errorCode);
        this.log.info({ messageId: pending.id, status: receipt }, 'Receipt updated');
      } else {
        this.store.recordReceiptCheck(pending.id);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
