import { randomUUID } from 'node:crypto';
import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
  type AgentDwsAccountStore,
} from '../data/agentDwsAccounts/index.js';
import type {
  DwsDeliverySession,
  PgDwsDeliveryStore,
} from '../data/agentDwsAccounts/durableDeliveryStore.js';
import { classifyDwsIntake } from './durableEventValidation.js';
import { DwsReceiverClient } from './dwsReceiverClient.js';
import type { DwsEventGateway, DwsPersonalEvent } from './personalEventGateway.js';

const RECONCILE_MS = 1_000;
const STOP_CONFIRM_MS = 20_000;

export class DurableDwsEventGateway implements DwsEventGateway {
  private readonly active = new Map<
    string,
    { account: AgentDwsAccountRecord; controller: AbortController; task: Promise<void> }
  >();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly options: {
      accountStore: AgentDwsAccountStore;
      deliveryStore: PgDwsDeliveryStore;
      clientFor(account: AgentDwsAccountRecord): Promise<DwsReceiverClient>;
      onEvent(account: AgentDwsAccountRecord, event: DwsPersonalEvent): Promise<void>;
      isExecutionEnabled?: () => boolean | Promise<boolean>;
      logger?: { info(message: string): void; warn(message: string): void };
    },
  ) {}

  async startAll(): Promise<void> {
    if (this.stopped) return;
    await this.reconcile();
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(
      () => void this.reconcile().catch((error) => this.warn('reconcile', error)),
      30_000,
    );
    this.reconcileTimer.unref?.();
  }

  async startAccount(account: AgentDwsAccountRecord): Promise<void> {
    if (
      this.stopped ||
      account.deliveryProtocol !== 'durable-v1' ||
      account.status !== 'active' ||
      !hasExactAgentDwsProfile(account) ||
      this.active.has(account.accountId)
    )
      return;
    if (this.options.isExecutionEnabled && !(await this.options.isExecutionEnabled())) return;
    const controller = new AbortController();
    const task = this.consume(account, controller)
      .catch((error) => this.warn(`account=${account.accountId}`, error))
      .finally(() => {
        if (this.active.get(account.accountId)?.controller === controller)
          this.active.delete(account.accountId);
      });
    this.active.set(account.accountId, { account, controller, task });
  }

  async stopTenant(tenantId: string): Promise<void> {
    const accounts = await this.options.accountStore.listForTenant(tenantId);
    await Promise.all(
      accounts
        .filter((account) =>
          ['durable-v1', 'handoff_pending'].includes(account.deliveryProtocol ?? ''),
        )
        .map((account) => this.stopAccount(account.accountId, account)),
    );
  }

  async stopAccount(accountId: string, account?: AgentDwsAccountRecord): Promise<void> {
    const active = this.active.get(accountId);
    active?.controller.abort();
    await active?.task.catch(() => undefined);
    this.active.delete(accountId);
    const target = account ?? active?.account;
    if (!target || !['durable-v1', 'handoff_pending'].includes(target.deliveryProtocol ?? ''))
      return;
    let session: DwsDeliverySession | null = null;
    try {
      session = await this.options.deliveryStore.claim(target, `dws-stop:${randomUUID()}`, 'stop');
      if (!session) throw new Error('receiver_stop_owner_unavailable');
      const client = await this.options.clientFor(target);
      await client.capabilities();
      await client.control('adopt', session).catch(() => undefined);
      await client.control('stop', session);
      const deadline = Date.now() + STOP_CONFIRM_MS;
      while (Date.now() < deadline) {
        const snapshot = await client.control('status', session);
        if (snapshot.state === 'stopped' && snapshot.proof) {
          await this.options.deliveryStore.updateRuntimeStatus(session.owner, 'stopped');
          await this.options.deliveryStore.release(session.owner);
          return;
        }
        await delay(RECONCILE_MS);
      }
      throw new Error('receiver_stop_unconfirmed');
    } catch (error) {
      if (session)
        await this.options.deliveryStore
          .recordBlocker(session.owner, code(error))
          .catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.task));
    this.active.clear();
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.options.isExecutionEnabled && !(await this.options.isExecutionEnabled())) return;
    const accounts = await this.options.accountStore.listRunnable({
      deliveryProtocol: 'durable-v1',
    });
    await Promise.all(accounts.map((account) => this.startAccount(account)));
  }

  private async consume(
    account: AgentDwsAccountRecord,
    controller: AbortController,
  ): Promise<void> {
    let session = await this.options.deliveryStore.claim(account, `dws-consumer:${randomUUID()}`);
    if (!session) return;
    const client = await this.options.clientFor(account);
    try {
      await client.capabilities(controller.signal);
      let snapshot;
      try {
        snapshot = await client.control('adopt', session, {}, controller.signal);
      } catch {
        snapshot = await client.control('start', session, {}, controller.signal);
      }
      await this.options.deliveryStore.updateRuntimeStatus(
        session.owner,
        snapshot.sourceReady ? 'ready' : 'starting',
      );
      let renewAt = Date.now() + 15_000;
      while (!controller.signal.aborted) {
        if (Date.now() >= renewAt) {
          const owner = await this.options.deliveryStore.renew(session.owner);
          session = { ...session, owner };
          snapshot = await client.control('renew', session, {}, controller.signal);
          renewAt = Date.now() + 15_000;
        } else {
          snapshot = await client.control('status', session, {}, controller.signal);
        }
        if (
          snapshot.state === 'stopped' ||
          snapshot.state === 'unknown' ||
          snapshot.state === 'blocked'
        ) {
          throw new Error(snapshot.reasonCode ?? `receiver_${snapshot.state}`);
        }
        if (snapshot.acknowledgedSequence > session.acknowledgedCursor) {
          await this.options.deliveryStore.acknowledged(
            session.owner,
            snapshot.acknowledgedSequence,
          );
          session = { ...session, acknowledgedCursor: snapshot.acknowledgedSequence };
        }
        const page = await client.control(
          'read',
          session,
          {
            after: snapshot.acknowledgedSequence,
            limit: 32,
          },
          controller.signal,
        );
        if (page.records?.length) {
          const receivedCursor = await this.options.deliveryStore.accept(
            session.owner,
            page.records,
          );
          session = { ...session, receivedCursor };
        }
        for (const item of await this.options.deliveryStore.pending(session.owner)) {
          const intake = classifyDwsIntake(item.bytes);
          if (!intake.event) {
            await this.options.deliveryStore.deadLetter(
              session.owner,
              item.sequence,
              intake.reason ?? 'invalid_ndjson',
            );
            continue;
          }
          await this.options.onEvent(account, intake.event);
          await this.options.deliveryStore.forwarded(session.owner, item.sequence);
          await this.options.deliveryStore.markEvent(session.owner, new Date());
        }
        const ackableCursor = await this.options.deliveryStore.ackableCursor(session.owner);
        if (ackableCursor > snapshot.acknowledgedSequence) {
          snapshot = await client.control(
            'ack',
            session,
            { through: ackableCursor },
            controller.signal,
          );
          await this.options.deliveryStore.acknowledged(
            session.owner,
            snapshot.acknowledgedSequence,
          );
          session = { ...session, acknowledgedCursor: snapshot.acknowledgedSequence };
        }
        if (snapshot.sourceReady)
          await this.options.deliveryStore.updateRuntimeStatus(session.owner, 'ready');
        await delay(RECONCILE_MS, controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.options.deliveryStore
          .recordBlocker(session.owner, code(error))
          .catch(() => undefined);
        await this.options.deliveryStore
          .updateRuntimeStatus(session.owner, 'error', code(error))
          .catch(() => undefined);
      }
    } finally {
      await this.options.deliveryStore.release(session.owner).catch(() => undefined);
    }
  }

  private warn(context: string, error: unknown): void {
    this.options.logger?.warn(`DWS durable receiver ${context}: ${code(error)}`);
  }
}

export class DwsEventGatewayMultiplexer implements DwsEventGateway {
  constructor(
    private readonly legacy: DwsEventGateway,
    private readonly durable: DwsEventGateway,
  ) {}
  async startAll(): Promise<void> {
    await Promise.all([this.legacy.startAll(), this.durable.startAll()]);
  }
  async startAccount(account: AgentDwsAccountRecord): Promise<void> {
    await (account.deliveryProtocol === 'durable-v1' ? this.durable : this.legacy).startAccount(
      account,
    );
  }
  async stopTenant(tenantId: string): Promise<void> {
    await Promise.all([this.legacy.stopTenant(tenantId), this.durable.stopTenant(tenantId)]);
  }
  async stopAccount(accountId: string, account?: AgentDwsAccountRecord): Promise<void> {
    await Promise.all([
      this.legacy.stopAccount(accountId, account),
      this.durable.stopAccount(accountId, account),
    ]);
  }
  async stop(): Promise<void> {
    await Promise.all([this.legacy.stop(), this.durable.stop()]);
  }
}

function code(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,128}$/.test(value) ? value : 'receiver_runtime_unavailable';
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal?.addEventListener('abort', finish, { once: true });
  });
}
