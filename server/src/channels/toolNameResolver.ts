/**
 * Tool Name Resolver — re-exports from shared/lib/toolDisplay.
 *
 * All pure resolution logic lives in shared/src/lib/toolDisplay.ts.
 * This file exists for backward compatibility with server-side imports.
 */

export {
  resolveDisplayToolName,
  isSkillTool,
  normalizeInternalToolNameStrategy,
  resolveMcpToolNameStrategy,
  resolveSkillToolNameStrategy,
  composeToolNameResolver,
} from '../../../shared/src/lib/toolDisplay.js';

export type {
  ResolveToolNameParams,
  ToolNameResolver,
  ToolNameStrategy,
  ToolNameStrategyParams,
} from '../../../shared/src/lib/toolDisplay.js';
