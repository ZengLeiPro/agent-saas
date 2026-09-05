import type { AppConfig } from './config.js';

export type ToolControlsRuntimeUpdateCommit = () => void;

export interface ToolControlsRuntimeUpdateTarget {
  toolControls?: AppConfig['toolControls'];
}

/**
 * 准备后续 RawRuntime dispatch 使用的工具开关快照，但不在 prepare 阶段产生副作用。
 * undefined 是有效候选：commit 时删除执行侧字段，使默认开关与默认描述立即恢复。
 */
export function createToolControlsRuntimeUpdatePreparer(
  target: ToolControlsRuntimeUpdateTarget,
): (next: AppConfig['toolControls']) => ToolControlsRuntimeUpdateCommit {
  return (next) => {
    const snapshot = next === undefined ? undefined : structuredClone(next);
    return () => {
      if (snapshot === undefined) delete target.toolControls;
      else target.toolControls = snapshot;
    };
  };
}
