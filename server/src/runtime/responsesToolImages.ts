import { defendUserMessageText } from './agentPlanDefense.js';
import { modelSupportsImage, readImagePartOrPlaceholder } from './imageAttachments.js';
import type { ModelChatMessage } from './types.js';

type ResponsesImageContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'high' | 'original' };

export async function buildResponsesToolImageItems(input: {
  message: Extract<ModelChatMessage, { role: 'tool' }>;
  cwd: string;
  inputModalities?: readonly string[];
  sessionIdShort?: string;
}): Promise<Array<{
  type: 'message';
  role: 'user';
  content: ResponsesImageContent[];
}>> {
  if (!input.message.images?.length) return [];
  if (!modelSupportsImage(input.inputModalities)) {
    return [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: defendUserMessageText(
          '[Read 返回了图片，但当前模型未启用视觉输入，无法查看图片内容。]',
          input.sessionIdShort,
        ),
      }],
    }];
  }
  const content: ResponsesImageContent[] = [];
  for (const image of input.message.images) {
    const dataUrl = await readImagePartOrPlaceholder(input.cwd, image);
    if (typeof dataUrl !== 'string') {
      content.push({
        type: 'input_text',
        text: defendUserMessageText(dataUrl.placeholder, input.sessionIdShort),
      });
      continue;
    }
    content.push({ type: 'input_image', image_url: dataUrl, detail: image.detail });
  }
  return [{ type: 'message', role: 'user', content }];
}
