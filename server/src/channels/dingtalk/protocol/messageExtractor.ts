/**
 * 钉钉消息内容提取
 *
 * 从钉钉回调数据中提取消息文本，支持多种消息类型。
 * 被 webhookRouter 和 streamClient 共用，消除重复代码。
 */

export interface ExtractedMessage {
  text: string;
  msgtype: string;
}

/**
 * 从钉钉回调数据中提取消息内容
 * @param data - 钉钉回调 body（Webhook）或 JSON.parse(res.data)（Stream）
 */
export function extractMessageContent(data: any): ExtractedMessage {
  const msgtype = data.msgtype || 'text';

  let text = data.text?.content?.trim() || '';
  if (!text && msgtype === 'picture') text = '请描述这张图片';
  else if (!text && msgtype === 'audio') text = data.content?.recognition || '[语音消息]';
  else if (!text && msgtype === 'video') text = '[用户发送了一个视频]';
  else if (!text && msgtype === 'file') text = `[用户发送了文件: ${data.content?.fileName || '文件'}]`;
  else if (!text && msgtype === 'richText') {
    const parts = data.content?.richText || [];
    text = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') || '[富文本消息]';
  }

  return { text, msgtype };
}
