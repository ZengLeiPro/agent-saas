/**
 * Display Config Module Tests
 *
 * 测试消息显示配置判断函数
 */

import { describe, it, expect } from 'vitest';
import {
  shouldSendWebBlock,
  shouldSendWebToolResult,
  getWebDisplayConfig,
  type WebBlockType,
} from '../channels/web/displayFilter.js';
import {
  shouldSendDingtalkBlockStart,
  shouldSendDingtalkBlockComplete,
  getDingtalkDisplayConfig,
} from '../channels/dingtalk/pipeline/displayFilter.js';
import type {
  WebMessageDisplayConfig,
  DingtalkMessageDisplayConfig,
} from '../types/index.js';

describe('DisplayConfig', () => {
  describe('shouldSendWebBlock', () => {
    describe('text blocks', () => {
      it('should always send text blocks regardless of config', () => {
        expect(shouldSendWebBlock('text', undefined, {})).toBe(true);
        expect(shouldSendWebBlock('text', undefined, { thinking: false })).toBe(true);
        expect(shouldSendWebBlock('text', undefined, { toolInput: false })).toBe(true);
        expect(shouldSendWebBlock('text', 'SomeTool', {})).toBe(true);
      });
    });

    describe('thinking blocks', () => {
      it('should send thinking blocks by default', () => {
        expect(shouldSendWebBlock('thinking', undefined, {})).toBe(true);
      });

      it('should send thinking blocks when thinking is true', () => {
        expect(shouldSendWebBlock('thinking', undefined, { thinking: true })).toBe(true);
      });

      it('should not send thinking blocks when thinking is false', () => {
        expect(shouldSendWebBlock('thinking', undefined, { thinking: false })).toBe(false);
      });
    });

    describe('tool_use blocks - regular tools', () => {
      it('should send regular tool blocks by default', () => {
        expect(shouldSendWebBlock('tool_use', 'Read', {})).toBe(true);
        expect(shouldSendWebBlock('tool_use', 'Write', {})).toBe(true);
        expect(shouldSendWebBlock('tool_use', 'Bash', {})).toBe(true);
      });

      it('should send regular tool blocks when toolInput is true', () => {
        expect(shouldSendWebBlock('tool_use', 'Read', { toolInput: true })).toBe(true);
      });

      it('should not send regular tool blocks when toolInput is false', () => {
        expect(shouldSendWebBlock('tool_use', 'Read', { toolInput: false })).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'Write', { toolInput: false })).toBe(false);
      });

      it('should handle undefined tool name', () => {
        expect(shouldSendWebBlock('tool_use', undefined, {})).toBe(true);
        expect(shouldSendWebBlock('tool_use', undefined, { toolInput: false })).toBe(false);
      });
    });

    describe('tool_use blocks - interactive tools', () => {
      it('should never send interactive tool blocks regardless of config', () => {
        expect(shouldSendWebBlock('tool_use', 'AskUserQuestion', {})).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'EnterPlanMode', {})).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'ExitPlanMode', {})).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'AskUserQuestion', { toolInput: true })).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'EnterPlanMode', { toolInput: true })).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'ExitPlanMode', { toolInput: true })).toBe(false);
      });

      it('should never send interactive tool results regardless of config', () => {
        expect(shouldSendWebToolResult('AskUserQuestion', {})).toBe(false);
        expect(shouldSendWebToolResult('EnterPlanMode', {})).toBe(false);
        expect(shouldSendWebToolResult('ExitPlanMode', {})).toBe(false);
        expect(shouldSendWebToolResult('AskUserQuestion', { toolResult: true })).toBe(false);
      });
    });

    describe('tool_use blocks - Skill tools', () => {
      it('should send Skill blocks by default', () => {
        expect(shouldSendWebBlock('tool_use', 'Skill', {})).toBe(true);
        expect(shouldSendWebBlock('tool_use', 'Skill:test', {})).toBe(true);
        expect(shouldSendWebBlock('tool_use', 'Skill:some-skill', {})).toBe(true);
      });

      it('should send Skill blocks when skillInput is true', () => {
        expect(shouldSendWebBlock('tool_use', 'Skill', { skillInput: true })).toBe(true);
        expect(shouldSendWebBlock('tool_use', 'Skill:test', { skillInput: true })).toBe(true);
      });

      it('should not send Skill blocks when skillInput is false', () => {
        expect(shouldSendWebBlock('tool_use', 'Skill', { skillInput: false })).toBe(false);
        expect(shouldSendWebBlock('tool_use', 'Skill:test', { skillInput: false })).toBe(false);
      });

      it('should use skillInput config for Skill, not toolInput', () => {
        // skillInput: true, toolInput: false - Skill should still be sent
        expect(shouldSendWebBlock('tool_use', 'Skill', { skillInput: true, toolInput: false })).toBe(true);

        // skillInput: false, toolInput: true - Skill should not be sent
        expect(shouldSendWebBlock('tool_use', 'Skill', { skillInput: false, toolInput: true })).toBe(false);
      });
    });

    describe('unknown block types', () => {
      it('should return false for unknown block types', () => {
        expect(shouldSendWebBlock('unknown' as WebBlockType, undefined, {})).toBe(false);
      });
    });
  });

  describe('shouldSendWebToolResult', () => {
    describe('regular tools', () => {
      it('should send regular tool results by default', () => {
        expect(shouldSendWebToolResult('Read', {})).toBe(true);
        expect(shouldSendWebToolResult('Write', {})).toBe(true);
      });

      it('should send regular tool results when toolResult is true', () => {
        expect(shouldSendWebToolResult('Read', { toolResult: true })).toBe(true);
      });

      it('should not send regular tool results when toolResult is false', () => {
        expect(shouldSendWebToolResult('Read', { toolResult: false })).toBe(false);
      });

      it('should handle undefined tool name', () => {
        expect(shouldSendWebToolResult(undefined, {})).toBe(true);
        expect(shouldSendWebToolResult(undefined, { toolResult: false })).toBe(false);
      });
    });

    describe('Skill tools', () => {
      it('should send Skill results by default', () => {
        expect(shouldSendWebToolResult('Skill', {})).toBe(true);
        expect(shouldSendWebToolResult('Skill:test', {})).toBe(true);
      });

      it('should send Skill results when skillResult is true', () => {
        expect(shouldSendWebToolResult('Skill', { skillResult: true })).toBe(true);
      });

      it('should not send Skill results when skillResult is false', () => {
        expect(shouldSendWebToolResult('Skill', { skillResult: false })).toBe(false);
        expect(shouldSendWebToolResult('Skill:test', { skillResult: false })).toBe(false);
      });

      it('should use skillResult config for Skill, not toolResult', () => {
        expect(shouldSendWebToolResult('Skill', { skillResult: true, toolResult: false })).toBe(true);
        expect(shouldSendWebToolResult('Skill', { skillResult: false, toolResult: true })).toBe(false);
      });
    });
  });

  describe('shouldSendDingtalkBlockStart', () => {
    describe('thinking blocks', () => {
      it('should send thinking start by default', () => {
        expect(shouldSendDingtalkBlockStart('thinking', undefined, {})).toBe(true);
      });

      it('should send thinking start when thinking is true', () => {
        expect(shouldSendDingtalkBlockStart('thinking', undefined, { thinking: true })).toBe(true);
      });

      it('should not send thinking start when thinking is false', () => {
        expect(shouldSendDingtalkBlockStart('thinking', undefined, { thinking: false })).toBe(false);
      });
    });

    describe('tool_use blocks - regular tools', () => {
      it('should send regular tool start by default', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Read', {})).toBe(true);
        expect(shouldSendDingtalkBlockStart('tool_use', 'Write', {})).toBe(true);
      });

      it('should send regular tool start when toolStart is true', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Read', { toolStart: true })).toBe(true);
      });

      it('should not send regular tool start when toolStart is false', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Read', { toolStart: false })).toBe(false);
      });
    });

    describe('tool_use blocks - Skill tools', () => {
      it('should send Skill start by default', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Skill', {})).toBe(true);
        expect(shouldSendDingtalkBlockStart('tool_use', 'Skill:test', {})).toBe(true);
      });

      it('should send Skill start when skillStart is true', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Skill', { skillStart: true })).toBe(true);
      });

      it('should not send Skill start when skillStart is false', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Skill', { skillStart: false })).toBe(false);
      });

      it('should use skillStart config for Skill, not toolStart', () => {
        expect(shouldSendDingtalkBlockStart('tool_use', 'Skill', { skillStart: true, toolStart: false })).toBe(true);
        expect(shouldSendDingtalkBlockStart('tool_use', 'Skill', { skillStart: false, toolStart: true })).toBe(false);
      });
    });

    describe('text blocks', () => {
      it('should never send text block start', () => {
        expect(shouldSendDingtalkBlockStart('text', undefined, {})).toBe(false);
        expect(shouldSendDingtalkBlockStart('text', undefined, { thinking: true })).toBe(false);
      });
    });
  });

  describe('shouldSendDingtalkBlockComplete', () => {
    describe('tool_use blocks - regular tools', () => {
      it('should not send regular tool complete by default', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Read', {})).toBe(false);
      });

      it('should send regular tool complete when toolComplete is true', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Read', { toolComplete: true })).toBe(true);
      });

      it('should not send regular tool complete when toolComplete is false', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Read', { toolComplete: false })).toBe(false);
      });
    });

    describe('tool_use blocks - Skill tools', () => {
      it('should not send Skill complete by default', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill', {})).toBe(false);
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill:test', {})).toBe(false);
      });

      it('should send Skill complete when skillComplete is true', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill', { skillComplete: true })).toBe(true);
      });

      it('should not send Skill complete when skillComplete is false', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill', { skillComplete: false })).toBe(false);
      });

      it('should use skillComplete config for Skill, not toolComplete', () => {
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill', { skillComplete: true, toolComplete: false })).toBe(true);
        expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill', { skillComplete: false, toolComplete: true })).toBe(false);
      });
    });

    describe('thinking and text blocks', () => {
      it('should never send thinking block complete', () => {
        expect(shouldSendDingtalkBlockComplete('thinking', undefined, {})).toBe(false);
        expect(shouldSendDingtalkBlockComplete('thinking', undefined, { toolComplete: true })).toBe(false);
      });

      it('should never send text block complete', () => {
        expect(shouldSendDingtalkBlockComplete('text', undefined, {})).toBe(false);
      });
    });
  });

  describe('getWebDisplayConfig', () => {
    it('should return empty object when config is undefined', () => {
      expect(getWebDisplayConfig(undefined)).toEqual({});
    });

    it('should return the same config when provided', () => {
      const config: WebMessageDisplayConfig = {
        thinking: true,
        toolInput: false,
        toolResult: true,
      };
      expect(getWebDisplayConfig(config)).toEqual(config);
    });

    it('should handle partial config', () => {
      const config: WebMessageDisplayConfig = { thinking: false };
      expect(getWebDisplayConfig(config)).toEqual({ thinking: false });
    });
  });

  describe('getDingtalkDisplayConfig', () => {
    it('should return empty object when config is undefined', () => {
      expect(getDingtalkDisplayConfig(undefined)).toEqual({});
    });

    it('should return the same config when provided', () => {
      const config: DingtalkMessageDisplayConfig = {
        thinking: true,
        toolStart: false,
        toolComplete: true,
      };
      expect(getDingtalkDisplayConfig(config)).toEqual(config);
    });

    it('should handle partial config', () => {
      const config: DingtalkMessageDisplayConfig = { skillStart: true };
      expect(getDingtalkDisplayConfig(config)).toEqual({ skillStart: true });
    });
  });

  describe('edge cases', () => {
    it('should handle tools with names containing Skill but not being Skill tools', () => {
      // "SkillBuilder" 不应该被视为 Skill 工具
      expect(shouldSendWebBlock('tool_use', 'SkillBuilder', { skillInput: false, toolInput: true })).toBe(true);
      expect(shouldSendWebBlock('tool_use', 'MySkill', { skillInput: false, toolInput: true })).toBe(true);
    });

    it('should handle Skill tool names with various suffixes', () => {
      expect(shouldSendWebBlock('tool_use', 'Skill:name:with:colons', { skillInput: false })).toBe(false);
      expect(shouldSendWebBlock('tool_use', 'Skill:', { skillInput: false })).toBe(false);
    });

    it('should handle empty string tool name', () => {
      expect(shouldSendWebBlock('tool_use', '', {})).toBe(true);
      expect(shouldSendWebBlock('tool_use', '', { toolInput: false })).toBe(false);
    });

    it('should handle all config options being set', () => {
      const fullWebConfig: WebMessageDisplayConfig = {
        thinking: false,
        toolInput: false,
        toolResult: false,
        skillInput: false,
        skillResult: false,
      };

      expect(shouldSendWebBlock('thinking', undefined, fullWebConfig)).toBe(false);
      expect(shouldSendWebBlock('tool_use', 'Read', fullWebConfig)).toBe(false);
      expect(shouldSendWebBlock('tool_use', 'Skill', fullWebConfig)).toBe(false);
      expect(shouldSendWebToolResult('Read', fullWebConfig)).toBe(false);
      expect(shouldSendWebToolResult('Skill', fullWebConfig)).toBe(false);

      const fullDingtalkConfig: DingtalkMessageDisplayConfig = {
        thinking: false,
        toolStart: false,
        toolComplete: false,
        skillStart: false,
        skillComplete: false,
      };

      expect(shouldSendDingtalkBlockStart('thinking', undefined, fullDingtalkConfig)).toBe(false);
      expect(shouldSendDingtalkBlockStart('tool_use', 'Read', fullDingtalkConfig)).toBe(false);
      expect(shouldSendDingtalkBlockStart('tool_use', 'Skill', fullDingtalkConfig)).toBe(false);
      expect(shouldSendDingtalkBlockComplete('tool_use', 'Read', fullDingtalkConfig)).toBe(false);
      expect(shouldSendDingtalkBlockComplete('tool_use', 'Skill', fullDingtalkConfig)).toBe(false);
    });
  });
});
