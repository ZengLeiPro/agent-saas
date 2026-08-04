/**
 * 连接器命令解析与 stdout 硬事实提取。
 *
 * 样本形态全部取自 2026-08-03 生产摸底的真实抽样，不是构造出来的理想输入：
 * 91.9% 的 Shell 是复合命令、65% 首词是 `cd`、27.7% 的 dws 调用才带
 * `--format json`、11.6% 根本是在读 `--help`、6.3% 经 python3 二次加工后
 * 只剩 Python repr。这些都是识别器必须正面回答的问题。
 */
import { describe, expect, it } from 'vitest';

import {
  extractConnectorFacts,
  extractStdoutSection,
  extractWhitelistedUrl,
  parseConnectorCommand,
  scanJsonFragments,
  splitCommandSegments,
  tokenizeSegment,
} from './connectorCommand.js';
import {
  BUILTIN_CONNECTOR_DICTIONARY,
  cloneBuiltinConnectorDictionary,
  matchesUrlWhitelist,
} from './connectorDictionary.js';

const DICT = BUILTIN_CONNECTOR_DICTIONARY;
const DWS = DICT.find((entry) => entry.binary === 'dws')!;

function parse(command: string) {
  return parseConnectorCommand(command, DICT);
}

describe('命令切段与分词', () => {
  it('按 && / ; / | / || 切段，引号内的控制符不切', () => {
    expect(splitCommandSegments('cd /w && dws todo list | head -5')).toEqual([
      'cd /w',
      'dws todo list',
      'head -5',
    ]);
    expect(splitCommandSegments(`printf 'a && b; c' ; dws auth status`)).toEqual([
      `printf 'a && b; c'`,
      'dws auth status',
    ]);
  });

  it('分词剥引号，值里的空格保留', () => {
    expect(tokenizeSegment(`dws todo create --title "复核 合同"`)).toEqual([
      'dws', 'todo', 'create', '--title', '复核 合同',
    ]);
  });
});

describe('连接器识别（生产真实命令形态）', () => {
  it('cd 开头的复合命令能认出后段的连接器——65% 的生产命令首词是 cd', () => {
    const parsed = parse('cd /workspace/projects/x && dws todo create --title 复核合同');
    expect(parsed).toMatchObject({ system: '钉钉', action: '创建待办', isWrite: true });
  });

  it('变量赋值与 npx/sudo 前缀被剥掉', () => {
    expect(parse('WT=projects/x npx dws todo create --title x')).toMatchObject({ action: '创建待办' });
    expect(parse('sudo /usr/local/bin/dws todo create')).toMatchObject({ action: '创建待办' });
  });

  it('多段命中时优先取写操作——客户关心的是那次创建，不是前面的探活', () => {
    const parsed = parse(`printf '=== auth ===' ; dws auth status --format json ; dws todo create --title x`);
    expect(parsed).toMatchObject({ action: '创建待办', isWrite: true });
  });

  it('只有读操作时取第一个命中段，且不标写操作', () => {
    const parsed = parse(`printf '=== auth ===' ; dws auth status --format json ; printf 'done'`);
    expect(parsed).toMatchObject({ system: '钉钉', action: '查看授权', isWrite: false });
  });

  it('嵌套子命令里找已登记的动词：dws todo task list → 查询待办', () => {
    expect(parse('dws todo task list --format json')).toMatchObject({ action: '查询待办', isWrite: false });
  });

  it('flag 的值不会被当成动词——`--title 复核合同` 里的中文不是子命令', () => {
    expect(parse('dws todo create --title 复核合同 --due 2026-08-10')).toMatchObject({ action: '创建待办' });
  });

  it('未登记模块用原词，未登记动词只写「模块 · 原词」且不标写操作', () => {
    expect(parse('lark im send --chat x')).toMatchObject({ system: '飞书', action: '发送群聊与消息', isWrite: true });
    expect(parse('dws todo frobnicate')).toMatchObject({ action: '待办 · frobnicate', isWrite: false });
  });

  it('--help / -h / help / --version 一律不产出业务动作标题', () => {
    // 生产 11.6% 的 dws 调用是读 help，渲染成「钉钉 · 待办」属语义造假
    expect(parse('dws todo create --help')).toBeNull();
    expect(parse('dws chat -h')).toBeNull();
    expect(parse('dws help todo')).toBeNull();
    expect(parse('dws --version')).toBeNull();
    expect(parse(`printf '=== help ===' ; dws chat send --help`)).toBeNull();
  });

  it('排除规则按整 token 匹配，不误伤同前缀的参数', () => {
    expect(parse('dws todo create --helper-flag x')).toMatchObject({ action: '创建待办' });
  });

  it('把 dws 输出管进 python3 时仍认出前段的连接器动作', () => {
    const parsed = parse(`cd /w && dws im conversation list --format json | python3 -c "import sys,json;print(json.load(sys.stdin).keys())"`);
    expect(parsed).toMatchObject({ system: '钉钉', action: '查询群聊与消息' });
  });

  it('普通命令不被误判成连接器', () => {
    expect(parse('cd /w && rg -n foo && git commit -m x')).toBeNull();
    expect(parse('python3 -c "print(1)"')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('停用的连接器条目不再识别——平台管理关掉即刻停止产出业务标题', () => {
    const disabled = cloneBuiltinConnectorDictionary().map((entry) =>
      entry.binary === 'dws' ? { ...entry, enabled: false } : entry);
    expect(parseConnectorCommand('dws todo create', disabled)).toBeNull();
  });

  // 2026-08-04：这批映射来自生产 60 天真实调用统计出的降级样本。缺映射不报错、
  // 只把英文原词漏给客户看，所以必须由测试锁住——否则下次动 COMMON_ACTION_VERBS
  // 或 dws 条目时会静默退化，而没有任何信号会告诉我们。
  it.each([
    ['dws chat message list-all --start x', '查询群聊与消息'],
    ['dws chat message list-by-sender --sender-user-id x', '查询群聊与消息'],
    ['dws chat conversation-info --user x', '查询群聊与消息'],
    ['dws contact user get-self --format json', '查询通讯录'],
    ['dws auth login', '登录授权'],
    ['dws profile list --format json', '查询账号配置'],
  ])('生产降级样本回归：%s → %s', (command, action) => {
    expect(parse(command)).toMatchObject({ system: '钉钉', action });
  });

  it('补的查询类动词一律 write=false——查询不盖回执章', () => {
    for (const cmd of ['dws chat message list-all', 'dws contact user get-self', 'dws auth login']) {
      expect(parse(cmd)).toMatchObject({ isWrite: false });
    }
  });
});

describe('贪婪 JSON 片段扫描', () => {
  it('从「分隔符 + JSON + 帮助文本」的混合 stdout 里捞出中间那段 JSON', () => {
    const stdout = [
      '=== auth ===',
      '{"dingOpenErrcode":0,"errorMsg":"ok","success":true,"result":{"userId":"01234"}}',
      '=== help ===',
      'Usage: dws chat [options]',
    ].join('\n');
    const fragments = scanJsonFragments(stdout);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ success: true });
  });

  it('多段 JSON 拼接时逐段解析——整段不是合法 JSON 不影响片段可用', () => {
    const stdout = '{"a":1}\n{"b":2}\n[{"c":3}]';
    expect(scanJsonFragments(stdout)).toHaveLength(3);
  });

  it('Python repr（单引号）不可解析，不产出任何片段——二手数据不冒充事实', () => {
    const stdout = `dict_keys(['arguments', 'errorCode', 'errorMsg', 'result', 'success'])\nconversations 100`;
    expect(scanJsonFragments(stdout)).toEqual([]);
  });

  it('被截断的 JSON 不产出片段', () => {
    expect(scanJsonFragments('{"taskUuid":"7632","title":"agent演示"')).toEqual([]);
  });
});

describe('URL 白名单', () => {
  it('通配匹配对齐边界，防止 evilfeishu.cn 冒充 *.feishu.cn', () => {
    expect(matchesUrlWhitelist('open.feishu.cn', ['*.feishu.cn'])).toBe(true);
    expect(matchesUrlWhitelist('feishu.cn', ['*.feishu.cn'])).toBe(true);
    expect(matchesUrlWhitelist('evilfeishu.cn', ['*.feishu.cn'])).toBe(false);
    expect(matchesUrlWhitelist('alidocs.dingtalk.com.evil.com', ['alidocs.dingtalk.com'])).toBe(false);
  });

  it('只认业务域名——生产样本里 34% 的含 URL 输出全是噪声域名', () => {
    const noisy = 'see https://github.com/foo/bar and https://registry.npmjs.org/x';
    expect(extractWhitelistedUrl(noisy, DWS.urlWhitelist)).toBeUndefined();
    const real = '已创建，查看：https://shanji.dingtalk.com/app/transcribes/7632';
    expect(extractWhitelistedUrl(real, DWS.urlWhitelist)).toBe('https://shanji.dingtalk.com/app/transcribes/7632');
  });

  it('白名单为空时一个都不认', () => {
    expect(extractWhitelistedUrl('https://alidocs.dingtalk.com/x', [])).toBeUndefined();
  });
});

describe('连接器 stdout 硬事实', () => {
  it('dws --format json 的真实回执：抽出成功标记、标题与可点链接', () => {
    const stdout = JSON.stringify({
      dingOpenErrcode: 0,
      errorMsg: 'ok',
      success: true,
      result: {
        taskUuid: '7632xxxxxxxx',
        title: 'agent演示',
        startTime: 1785483014000,
        url: 'https://shanji.dingtalk.com/app/transcribes/7632xxxxxxxx',
      },
    });
    const facts = extractConnectorFacts(stdout, DWS)!;
    expect(facts.objectId).toBe('7632xxxxxxxx');
    expect(facts.url).toBe('https://shanji.dingtalk.com/app/transcribes/7632xxxxxxxx');
    expect(facts.failed).toBe(false);
    expect(facts.fields).toContainEqual({ k: '结果', v: '成功' });
    expect(facts.fields).toContainEqual({ k: '标题', v: 'agent演示' });
  });

  it('aitable record create 的形态：status/summary 里只取白名单键', () => {
    const stdout = JSON.stringify({
      data: { newRecordIds: ['rec1', 'rec2'] },
      status: 'success',
      summary: 'Successfully created 2 record(s)',
    });
    const facts = extractConnectorFacts(stdout, DWS)!;
    expect(facts.fields).toContainEqual({ k: '状态', v: 'success' });
    // summary / newRecordIds 不在惯用键白名单里——摘要不是 JSON 查看器
    expect(facts.fields.some((field) => field.v.includes('Successfully'))).toBe(false);
  });

  it('回执自报失败时标记 failed，供产出方拒绝盖章', () => {
    const stdout = JSON.stringify({ success: false, errorMsg: '无权限', dingOpenErrcode: 88 });
    const facts = extractConnectorFacts(stdout, DWS)!;
    expect(facts.failed).toBe(true);
    expect(facts.fields).toContainEqual({ k: '错误信息', v: '无权限' });
  });

  it('中文表格 / 自由文本（72.3% 的 dws 调用）不产出任何事实', () => {
    const stdout = '老板进度看板 10\nad3de871 订单数 STATISTICS\n合计 128';
    expect(extractConnectorFacts(stdout, DWS)).toBeNull();
  });

  it('Python repr 二手数据不产出事实——那已经过一轮模型选择，违背本方案初衷', () => {
    const stdout = `dict_keys(['arguments', 'errorCode', 'errorMsg', 'result', 'success'])`;
    expect(extractConnectorFacts(stdout, DWS)).toBeNull();
  });

  it('对象 ID 按优先级取：taskUuid > taskId > recordId > id', () => {
    expect(extractConnectorFacts(JSON.stringify({ id: 'a', taskId: 'b', taskUuid: 'c' }), DWS)!.objectId).toBe('c');
    expect(extractConnectorFacts(JSON.stringify({ id: 'a', recordId: 'b' }), DWS)!.objectId).toBe('b');
    expect(extractConnectorFacts(JSON.stringify({ order_id: 'o-9' }), DWS)!.objectId).toBe('o-9');
  });

  it('超长 ID 不当作对象 ID——单据号不可能有 120 字符', () => {
    const facts = extractConnectorFacts(JSON.stringify({ id: 'x'.repeat(200), status: 'ok' }), DWS)!;
    expect(facts.objectId).toBeUndefined();
  });
});

describe('stdout 段抽取', () => {
  it('从 formatShellOutput 信封里只取 stdout 段，header 与 stderr 不算回执', () => {
    const output = [
      'Exit code: 0',
      'Output bytes: stdout=42 stderr=9',
      '',
      '[stdout]',
      '{"taskId":"t-1"}',
      '[stderr]',
      '{"taskId":"不该被读到"}',
    ].join('\n');
    expect(extractStdoutSection(output)).toContain('t-1');
    expect(extractStdoutSection(output)).not.toContain('不该被读到');
  });

  it('没有 stdout 段时返回 undefined，不退化成扫描整段正文', () => {
    expect(extractStdoutSection('Exit code: 0\n\n(no output)')).toBeUndefined();
    expect(extractStdoutSection('tool error: spawn ENOENT')).toBeUndefined();
  });
});
