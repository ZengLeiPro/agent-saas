import { describe, expect, it } from 'vitest';

import { collectSessionShareCandidateFiles } from '../data/sessionShares/publicProjection.js';
import type { TranscriptBlock } from '../data/transcripts/parse.js';
import { resolveSessionShareFileSelection } from './sessionShareSelection.js';

const candidates = [
  { relativePath: 'assets/公开.txt', fileName: '公开.txt' },
  { relativePath: 'assets/正文.png', fileName: '正文.png', inlineInBody: true as const },
];

describe('resolveSessionShareFileSelection', () => {
  it('新前端不提交清单时自动选择全部成果文件', () => {
    expect(resolveSessionShareFileSelection(undefined, candidates)).toEqual({
      ok: true,
      filePaths: ['assets/公开.txt', 'assets/正文.png'],
    });
  });

  it('旧前端仍可提交文件子集，但不能漏掉正文媒体', () => {
    expect(resolveSessionShareFileSelection(['assets/正文.png'], candidates)).toEqual({
      ok: true,
      filePaths: ['assets/正文.png'],
    });
    expect(resolveSessionShareFileSelection([], candidates)).toEqual({
      ok: false,
      error: '正文内嵌图片和视频必须随正文一并公开',
    });
  });
});

describe('collectSessionShareCandidateFiles', () => {
  it('仅从公开正文收集成果，不接受隐藏工具结果扩张下载范围', () => {
    const blocks = [
      { id: 'prompt', kind: 'prompt', content: '[FILE]{"filePath":"assets/公开.txt"}[/FILE]' },
      { id: 'tool', kind: 'tool_result', content: '[FILE]{"filePath":"assets/内部.txt"}[/FILE]' },
    ] as TranscriptBlock[];

    expect(collectSessionShareCandidateFiles(blocks)).toEqual([
      { relativePath: 'assets/公开.txt', fileName: '公开.txt' },
    ]);
  });
});
