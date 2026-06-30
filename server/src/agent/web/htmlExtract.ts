import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

export type ExtractMode = 'markdown' | 'text';
export type WebContentExtractor = 'readability' | 'basic_html' | 'text' | 'json' | 'raw';

export interface ExtractReadableContentResult {
  title?: string;
  text: string;
  extractor: WebContentExtractor;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export function extractReadableContent(
  body: string,
  params: {
    contentType: string;
    url: string;
    extractMode: ExtractMode;
  },
): ExtractReadableContentResult {
  const contentType = params.contentType.toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), extractor: 'json' };
    } catch {
      return { text: body, extractor: 'raw' };
    }
  }
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || looksLikeHtml(body);
  if (!isHtml) {
    return { title: textTitle(body, params.url), text: body, extractor: 'text' };
  }

  const { document } = parseHTML(body);
  removeNoisyNodes(document as unknown as Document);
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();
  if (article?.content) {
    const markdown = turndown.turndown(article.content).trim();
    if (markdown) {
      return {
        title: article.title || document.title || undefined,
        text: params.extractMode === 'text' ? markdownToPlainText(markdown) : markdown,
        extractor: 'readability',
      };
    }
  }

  const title = document.title?.trim() || undefined;
  const bodyText = document.body?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return {
    title,
    text: bodyText,
    extractor: 'basic_html',
  };
}

export function truncateChars(value: string, maxChars: number): { text: string; truncated: boolean; rawLength: number } {
  const rawLength = value.length;
  if (rawLength <= maxChars) return { text: value, truncated: false, rawLength };
  return { text: `${value.slice(0, maxChars)}\n\n[Content truncated at ${maxChars} chars.]`, truncated: true, rawLength };
}

function looksLikeHtml(value: string): boolean {
  const head = value.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head') || head.includes('<body');
}

function removeNoisyNodes(document: Document): void {
  for (const element of Array.from(document.querySelectorAll('script, style, noscript, iframe, svg'))) {
    element.remove();
  }
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```[^\n]*\n?/g, '').replace(/```$/g, ''))
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~-]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textTitle(text: string, url: string): string {
  const heading = text.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1) || url;
  } catch {
    return url;
  }
}
