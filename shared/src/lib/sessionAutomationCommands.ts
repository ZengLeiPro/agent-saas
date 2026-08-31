import type { SessionAutomationBudget, SessionAutomationSpec } from '../types/sessionAutomation.js';

export type ParsedSessionAutomationCommand =
  | { family: 'loop'; action: 'status' | 'list' | 'pause' | 'resume' | 'run' | 'clear' | 'reconcile' }
  | { family: 'loop'; action: 'create' | 'replace'; spec: SessionAutomationSpec }
  | { family: 'goal'; action: 'status' | 'pause' | 'resume' | 'clear' | 'reconcile' }
  | { family: 'goal'; action: 'create' | 'edit' | 'replace'; spec: SessionAutomationSpec };

export class SessionAutomationParseError extends Error {
  readonly code = 'INVALID_COMMAND';
}
const DURATION = /^(\d+)(s|m|h|d)$/;
const UNIT: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseAutomationDuration(value: string, minimumMs = 60_000): number {
  const match = DURATION.exec(value);
  if (!match) throw new SessionAutomationParseError(`无效 duration: ${value}`);
  const result = Number(match[1]) * UNIT[match[2]!]!;
  if (!Number.isSafeInteger(result) || result < minimumMs) throw new SessionAutomationParseError('duration 最小为 1m');
  return result;
}
function tokenize(input: string): string[] {
  const tokens = input.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => (/^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token));
}
function parseBudget(tokens: string[]): { budget: SessionAutomationBudget; prompt: string; duration?: number } {
  const budget: SessionAutomationBudget = {};
  let duration: number | undefined;
  const prompt: string[] = [];
  let literal = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (literal) { prompt.push(token); continue; }
    if (token === '--') { literal = true; continue; }
    if (i === 0 && DURATION.test(token)) { duration = parseAutomationDuration(token); continue; }
    const nextInt = (name: string): number => {
      const value = Number(tokens[++i]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new SessionAutomationParseError(`${name} 必须为正整数`);
      return value;
    };
    if (token === '--max-runs') { budget.maxRuns = nextInt(token); continue; }
    if (token === '--max-turns') { budget.maxTurns = nextInt(token); continue; }
    if (token === '--max-tokens') {
      const raw = tokens[++i];
      const match = /^(\d+)(k|m)?$/i.exec(raw ?? '');
      if (!match) throw new SessionAutomationParseError('--max-tokens 无效');
      budget.maxTokens = Number(match[1]) * (match[2]?.toLowerCase() === 'k' ? 1_000 : match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
      continue;
    }
    if (token === '--for') {
      const ms = parseAutomationDuration(tokens[++i] ?? '', 1_000);
      budget.expiresAt = new Date(Date.now() + ms).toISOString();
      continue;
    }
    if (token.startsWith('--')) throw new SessionAutomationParseError(`未知 flag: ${token}`);
    prompt.push(token);
  }
  return { budget, prompt: prompt.join(' ').trim(), ...(duration === undefined ? {} : { duration }) };
}

export function parseSessionAutomationCommand(input: string): ParsedSessionAutomationCommand | null {
  const trimmed = input.trim();
  if (!/^\/(loop|goal)(?:\s|$)/i.test(trimmed)) return null;
  const [head, ...tokens] = tokenize(trimmed);
  const family = head!.slice(1).toLowerCase() as 'loop' | 'goal';
  if (family === 'loop') {
    if (tokens.length === 0) return { family, action: 'status' };
    const forcedLiteral = tokens[0] === '--';
    const actionToken = tokens[0]!.toLowerCase();
    if (!forcedLiteral && ['status','list','pause','resume','run','reconcile','clear','stop'].includes(actionToken)) {
      if (tokens.length !== 1) throw new SessionAutomationParseError(`${actionToken} 不接受额外参数`);
      return { family, action: actionToken === 'stop' ? 'clear' : actionToken as 'status'|'list'|'pause'|'resume'|'run'|'reconcile'|'clear' };
    }
    const replace = !forcedLiteral && actionToken === 'replace';
    const parsed = parseBudget(tokens.slice(replace ? 1 : 0));
    const prompt = parsed.prompt || '检查当前会话目标的进展，处理可安全解决的问题，并报告状态。';
    return { family, action: replace ? 'replace' : 'create', spec: {
      kind: 'loop', mode: parsed.duration ? 'fixed' : 'adaptive', prompt,
      ...(parsed.duration ? { intervalMs: parsed.duration } : {}), budget: parsed.budget,
    } };
  }
  if (tokens.length === 0) return { family, action: 'status' };
  const forcedLiteral = tokens[0] === '--';
  const actionToken = tokens[0]!.toLowerCase();
  if (!forcedLiteral && ['status','pause','resume','reconcile','clear','stop','off','reset','none','cancel'].includes(actionToken)) {
    if (tokens.length !== 1) throw new SessionAutomationParseError(`${actionToken} 不接受额外参数`);
    return { family, action: ['stop','off','reset','none','cancel'].includes(actionToken) ? 'clear' : actionToken as 'status'|'pause'|'resume'|'reconcile'|'clear' };
  }
  let action: 'create'|'edit'|'replace' = 'create';
  let args = tokens;
  if (!forcedLiteral && ['set','edit','replace'].includes(actionToken)) {
    action = actionToken === 'set' ? 'create' : actionToken as 'edit'|'replace'; args = tokens.slice(1);
  }
  const parsed = parseBudget(args);
  if (!parsed.prompt || parsed.prompt.length > 16_000) throw new SessionAutomationParseError('Goal condition 必须为 1..16000 字符');
  return { family, action, spec: { kind: 'goal', mode: 'goal', condition: parsed.prompt, budget: parsed.budget } };
}
