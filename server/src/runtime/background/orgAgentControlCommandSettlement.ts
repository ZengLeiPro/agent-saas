import type {
  OrgAgentControlInboxReceipt,
  OrgGroupAgentStore,
} from '../../data/orgGroupAgents/index.js';

export class OrgAgentControlCommandUnsettledError extends Error {
  readonly operationError: unknown;
  readonly settlementError: unknown;

  constructor(operationError: unknown, settlementError: unknown) {
    super('ORG_AGENT_CONTROL_COMMAND_SETTLEMENT_FAILED', { cause: settlementError });
    this.name = 'OrgAgentControlCommandUnsettledError';
    this.operationError = operationError;
    this.settlementError = settlementError;
  }
}

export function isOrgAgentControlCommandUnsettledError(
  error: unknown,
): error is OrgAgentControlCommandUnsettledError {
  return error instanceof OrgAgentControlCommandUnsettledError;
}

export async function failPreparedOrgAgentControlCommand(input: {
  store: OrgGroupAgentStore;
  tenantId: string;
  workOrderId: string;
  inboxReceipt: OrgAgentControlInboxReceipt;
  operationError: unknown;
}): Promise<void> {
  try {
    await input.store.failControlCommand({
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      inboxReceipt: input.inboxReceipt,
      error:
        input.operationError instanceof Error
          ? input.operationError.message
          : String(input.operationError),
    });
  } catch (settlementError) {
    throw new OrgAgentControlCommandUnsettledError(input.operationError, settlementError);
  }
}

export function controlCommandCompletionUnsettled(settlementError: unknown): Error {
  return new OrgAgentControlCommandUnsettledError(
    new Error('ORG_AGENT_CONTROL_COMMAND_COMPLETION_UNCONFIRMED'),
    settlementError,
  );
}

export async function withPreparedOrgAgentControlFailureSettlement<T>(input: {
  store: OrgGroupAgentStore;
  tenantId: string;
  workOrderId: string;
  inboxReceipt?: OrgAgentControlInboxReceipt;
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.operation();
  } catch (operationError) {
    if (!input.inboxReceipt || isOrgAgentControlCommandUnsettledError(operationError))
      throw operationError;
    let workOrder;
    try {
      workOrder = await input.store.getWorkOrder(input.tenantId, input.workOrderId);
    } catch (settlementError) {
      throw new OrgAgentControlCommandUnsettledError(operationError, settlementError);
    }
    if (
      workOrder?.control.command?.inboxId === input.inboxReceipt.inboxId &&
      workOrder.control.command.phase === 'prepared'
    ) {
      await failPreparedOrgAgentControlCommand({
        store: input.store,
        tenantId: input.tenantId,
        workOrderId: input.workOrderId,
        inboxReceipt: input.inboxReceipt,
        operationError,
      });
    }
    throw operationError;
  }
}
