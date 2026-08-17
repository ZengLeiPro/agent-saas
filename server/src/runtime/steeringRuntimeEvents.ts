import type { SteeringApplyInput } from './runStoreTypes.js';
import type { PlatformEventInput } from './types.js';

export function selectSteeringEventCandidates(
  inputs: SteeringApplyInput[],
  appliedSourceRunIds: string[],
): { candidateEventInputs: PlatformEventInput[]; candidateSourceRunIds: string[] } {
  const appliedSet = new Set(appliedSourceRunIds);
  const candidateEventInputs = inputs
    .filter((input) => appliedSet.has(input.sourceRunId) && input.event)
    .map((input) => input.event!);
  const candidateSourceRunIds = candidateEventInputs.flatMap((eventInput) => (
    eventInput.type === 'user_message' && eventInput.interjectionSourceRunId
      ? [eventInput.interjectionSourceRunId]
      : []
  ));
  return { candidateEventInputs, candidateSourceRunIds };
}

export function buildAppliedSteeringEventInputs(args: {
  inputs: SteeringApplyInput[];
  appliedSourceRunIds: string[];
  candidateEventInputs: PlatformEventInput[];
  existingDurableSourceSet: Set<string>;
  targetRunId: string;
  sessionId: string;
}): PlatformEventInput[] {
  const appliedSet = new Set(args.appliedSourceRunIds);
  const eventInputs = args.candidateEventInputs.filter((eventInput) => (
    eventInput.type !== 'user_message'
    || !eventInput.interjectionSourceRunId
    || !args.existingDurableSourceSet.has(eventInput.interjectionSourceRunId)
  ));
  const clientMsgIds = args.inputs.flatMap((input) => (
    appliedSet.has(input.sourceRunId) && input.clientMsgId ? [input.clientMsgId] : []
  ));
  return [
    ...eventInputs,
    {
      type: 'interjection_applied',
      runId: args.targetRunId,
      sessionId: args.sessionId,
      sourceRunIds: args.appliedSourceRunIds,
      clientMsgIds,
    },
  ];
}
