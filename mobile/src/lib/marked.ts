import { Marked, type MarkedOptions } from 'marked';
import markedCjkFriendly from 'marked-cjk-friendly';

const cjkMarked = new Marked(markedCjkFriendly());

export function parseMarkdownToHtml(content: string, options?: MarkedOptions): string {
  return cjkMarked.parse(content, options) as string;
}
