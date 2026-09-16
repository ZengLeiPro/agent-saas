import type {
  HeadlessChatSubmission,
  HeadlessChatSubmissionResult,
  WebChannel,
} from '../channels/web/channel.js';

export interface HeadlessWebClient {
  submit(input: HeadlessChatSubmission): Promise<HeadlessChatSubmissionResult>;
}

export function createHeadlessWebClient(
  webChannel: Pick<WebChannel, 'submitHeadlessChat'>,
): HeadlessWebClient {
  return {
    submit: (input) => webChannel.submitHeadlessChat(input),
  };
}
