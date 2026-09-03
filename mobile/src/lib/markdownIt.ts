import MarkdownIt from 'markdown-it';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';

export const cjkMarkdownIt = new MarkdownIt({ typographer: true }).use(markdownItCjkFriendly);
