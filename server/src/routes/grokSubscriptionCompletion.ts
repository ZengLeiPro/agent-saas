import type { Request, Response } from 'express';
import {
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
} from '../config/adminConfigMutationService.js';
import { mutationRequestContext } from '../config/adminConfigMutationHttp.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import {
  GrokAdminInputError,
  grokAdminBody,
  grokAdminOwner,
  refsFromRaw,
  sendGrokAdminError,
  withGrokRefs,
  type GrokAdminContext,
} from './grokSubscriptionAdminSupport.js';
type CompletionState = Awaited<ReturnType<GrokAdminContext['publicState']>> & {
  status: 'applied';
  warning?: string;
};
interface CompletionTask {
  promise: Promise<CompletionState>;
  settled: boolean;
  createdAt: number;
  timer?: ReturnType<typeof setTimeout>;
}
/** The map only coalesces a live request. Durable production idempotency belongs to the operation journal. */
export class GrokSubscriptionCompletion {
  private readonly tasks = new Map<string, CompletionTask>();
  constructor(private readonly context: GrokAdminContext) {}
  isPending(sessionId: string, owner: string): boolean {
    return this.tasks.get(this.key(sessionId, owner))?.settled === false;
  }
  async handle(req: Request, res: Response): Promise<void> {
    let candidateRef: string | undefined;
    try {
      this.context.assertWritable();
      grokAdminBody(req, []);
      const sessionId = req.params.sessionId;
      const owner = grokAdminOwner(req);
      const key = this.key(sessionId, owner);
      const existing = this.tasks.get(key);
      if (existing) {
        res.json(await existing.promise);
        return;
      }
      this.reserveSlot();
      const promise = this.complete(req, sessionId, owner, (ref) => {
        candidateRef = ref;
      });
      const task: CompletionTask = { promise, settled: false, createdAt: Date.now() };
      this.tasks.set(key, task);
      void promise.then(
        () => {
          task.settled = true;
          task.timer = setTimeout(() => {
            if (this.tasks.get(key) === task) this.tasks.delete(key);
          }, this.context.options.completionTaskTtlMs ?? 300_000);
          task.timer.unref?.();
        },
        () => {
          if (this.tasks.get(key) === task) this.tasks.delete(key);
        },
      );
      res.json(await promise);
    } catch (error) {
      let warning: string | undefined;
      if (
        candidateRef &&
        !(error instanceof ConfigMutationCommittedError) &&
        !(error instanceof RuntimeRestoreFailedError)
      ) {
        try {
          await this.context.options.credentialManager.discardLoginCandidate(candidateRef);
        } catch {
          warning =
            '未发布候选凭据的本地清理未确认，请检查 SecretVault；未尝试远端撤销授权 grant。';
        }
      }
      sendGrokAdminError(res, error, warning);
    }
  }
  private async complete(
    req: Request,
    sessionId: string,
    owner: string,
    onCandidate: (ref: string) => void,
  ): Promise<CompletionState> {
    const { options } = this.context;
    try {
      if (options.deviceAuthService.status(sessionId, owner).status === 'applied')
        return { ...(await this.context.publicState()), status: 'applied' };
    } catch (error) {
      // A known durable operation may be replayed after an API restart. The journal, not this
      // missing in-memory session, determines whether the already-committed operation succeeded.
      if (!(error instanceof GrokProtocolError && error.code === 'authorization_not_found'))
        throw error;
    }
    const operationId = mutationRequestContext(req).operationId ?? sessionId;
    let replacedRef: string | undefined;
    const result = await this.context.mutate(
      req,
      'grok.complete',
      async (current) => {
        const authorized = options.deviceAuthService.authorizedResult(sessionId, owner);
        const refs = refsFromRaw(current);
        replacedRef = authorized.replaceCredentialRef;
        if (replacedRef && !refs.includes(replacedRef))
          throw new GrokAdminInputError('待重授权账号已被移除，请重新开始授权', 409);
        if (!replacedRef && refs.length >= 100)
          throw new GrokAdminInputError('Grok 账号数量已达到上限', 409);
        await options.credentialManager.assertUniqueAccount(authorized.tokens, refs, replacedRef);
        const candidate = await options.credentialManager.persistLogin(
          authorized.tokens,
          undefined,
          {
            configOperationId: operationId,
            ...(replacedRef ? { replacesCredentialRef: replacedRef } : {}),
          },
        );
        onCandidate(candidate.credentialRef);
        const nextRefs = replacedRef
          ? refs.map((ref) => (ref === replacedRef ? candidate.credentialRef : ref))
          : [...refs, candidate.credentialRef];
        return {
          ...withGrokRefs(current, nextRefs, true),
          quotaCooldownMinutes: current.quotaCooldownMinutes ?? 60,
        };
      },
      operationId,
    );
    try {
      options.deviceAuthService.complete(sessionId, owner);
    } catch (error) {
      if (!(error instanceof GrokProtocolError && error.code === 'authorization_not_found'))
        throw new ConfigMutationCommittedError(error);
    }
    let warning: string | undefined;
    if (replacedRef) {
      try {
        await options.credentialManager.revoke(replacedRef, false);
      } catch {
        warning = '新账号凭据已登记，旧凭据的本地清理未确认；未远端撤销可能共享的授权 grant。';
      }
    }
    return {
      ...(await this.context.publicState()),
      revision: result.revision,
      status: 'applied',
      ...(warning ? { warning } : {}),
    };
  }
  private key(sessionId: string, owner: string): string {
    return `${owner}\0${sessionId}`;
  }
  private reserveSlot(): void {
    if (this.tasks.size < (this.context.options.completionTaskLimit ?? 100)) return;
    const oldest = [...this.tasks]
      .filter(([, task]) => task.settled)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) throw new GrokAdminInputError('正在登记的 Grok 授权过多，请稍后重试', 429);
    if (oldest[1].timer) clearTimeout(oldest[1].timer);
    this.tasks.delete(oldest[0]);
  }
}
