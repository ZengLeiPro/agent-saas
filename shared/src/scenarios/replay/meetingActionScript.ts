import type { SystemPanelSnapshot } from "../../lib/systemPanel";
import type { ReplayScript } from "./types";

/**
 * 剧本三：会议事实、决定与行动引用可追溯。
 *
 * 骨架照 complianceGateScript 抄，四要素分别落在：
 *   ① 主动示弱——第 2 步抽取结果直接标出 2 项缺口，不替人补；
 *   ② 人改 AI 并被记账——第 5 步生产副总改两处口径，原结论一并留档；
 *   ③ 跨场景交叉引用——第 4 步给决议稳定编号，第 7 步商务侧反查指回会议原话；
 *   ④ 可下载产物——会议纪要 HTML（决议表 + 行动项表 + 出处段落）。
 * 外加两条：退回不是死路（rejectedBlocks），终态两栏（第 8 步）。
 *
 * 内容为示例数据，不对应任何真实企业、会议或人员。
 */

const MINUTES_PATH = "assets/demo/远洲重工Q2经营会纪要.html";

const MINUTES_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --ok: #15803d; --warn: #b45309; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  .sub { margin: 0 0 16px; color: var(--muted); font-size: 12px; }
  h2.sec { margin: 18px 0 8px; font-size: 13px; color: var(--brand); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 14px; }
  th, td { border: 1px solid var(--line); padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .no { color: var(--brand); font-weight: 600; white-space: nowrap; }
  .tag { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 3px; background: rgba(180, 83, 9, .12); color: var(--warn); font-size: 11px; }
  .tag2 { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 3px; background: rgba(100, 116, 139, .14); color: var(--muted); font-size: 11px; }
  .box { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .box h2 { margin: 0 0 8px; font-size: 13px; }
  .box p { margin: 0 0 8px; font-size: 13px; }
  .box p:last-child { margin-bottom: 0; }
  .kv { display: grid; grid-template-columns: 92px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv span:nth-child(odd) { color: var(--muted); }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span>minutes.yuanzhou-heavy.internal / meeting / 2026Q2-OPS / v1.0</span></div>

<h1>远洲重工集团 · 2026 年第二季度经营分析会 纪要</h1>
<p class="sub">2026-07-24 09:30–11:48 · 主持：总裁 蒋敬川 · 参会 7 人 · 记录版本 v1.0（2026-07-25 10:07 发布）</p>

<div class="box">
  <h2>会议事实（节选，均带片段定位）</h2>
  <div class="kv">
    <span>Q2 营收</span><span>4.82 亿元，环比 +3.1% · 出处 T-0031 [00:12:40]</span>
    <span>综合毛利率</span><span>21.3%，同比 -2.1pt · 出处 T-0034 [00:14:02]</span>
    <span>质量异议</span><span>37 起，平均处理 14.6 天 · 出处 T-0138 [01:06:20]</span>
    <span>逾期交付</span><span>12 单，集中在中厚板备件 · 出处 T-0203 [01:31:55]</span>
  </div>
</div>

<h2 class="sec">决议（5 条）</h2>
<table>
  <tr><th>编号</th><th>决议内容</th><th>责任人</th><th>到期</th><th>出处 / 来源</th></tr>
  <tr><td class="no">R-2026Q2-01</td><td>QZ-9 产线三季度产能上调 15%，出排产方案</td><td>郑维（生产副总）</td><td>2026-08-10</td><td>T-0087 [00:41:33]</td></tr>
  <tr><td class="no">R-2026Q2-02</td><td>中厚板备件板块<b>暂缓</b>新增投入，Q3 末复盘后再定<span class="tag">人工修改</span></td><td>何立（供应链总监）</td><td>2026-09-30</td><td>T-0211 [01:35:07] + 07-25 更正</td></tr>
  <tr><td class="no">R-2026Q2-03</td><td>质量异议处理时限由 14 天压缩至 7 天，2026-08-01 起对新签合同生效</td><td>林知远（质量总监）</td><td>2026-07-31</td><td>T-0142 [01:08:12]</td></tr>
  <tr><td class="no">R-2026Q2-04</td><td>A 类物料改为双源供应，完成第二供应商认证</td><td>何立（供应链总监）<span class="tag2">会后补充</span></td><td>2026-12-31<span class="tag2">会后补充</span></td><td>T-0256 [01:52:44]，责任人与到期非会上原话</td></tr>
  <tr><td class="no">R-2026Q2-05</td><td>研发费用加计扣除口径统一并下发说明</td><td>周敏（财务总监）</td><td>2026-08-15<span class="tag2">会后补充</span></td><td>T-0301 [02:06:31]，会上原话为「尽快」</td></tr>
</table>

<h2 class="sec">行动项（7 条，已下发至责任人待办）</h2>
<table>
  <tr><th>编号</th><th>行动项</th><th>责任人</th><th>到期</th><th>来源决议</th></tr>
  <tr><td class="no">A-01</td><td>QZ-9 三季度排产方案</td><td>郑维</td><td>2026-08-10</td><td>R-2026Q2-01</td></tr>
  <tr><td class="no">A-02</td><td>中厚板板块 Q3 末复盘材料<span class="tag">口径已修改</span></td><td>何立</td><td>2026-09-30</td><td>R-2026Q2-02</td></tr>
  <tr><td class="no">A-03</td><td>修订《质量异议处理办法》至 7 天，仅对 2026-08-01 起新签合同生效<span class="tag">范围已修改</span></td><td>林知远</td><td>2026-07-31</td><td>R-2026Q2-03</td></tr>
  <tr><td class="no">A-04</td><td>销售合同模板 CT-TMPL-03 同步 7 天条款</td><td>徐岚（商务部）</td><td>2026-08-05</td><td>R-2026Q2-03</td></tr>
  <tr><td class="no">A-05</td><td>A 类物料第二供应商认证</td><td>何立</td><td>2026-12-31</td><td>R-2026Q2-04</td></tr>
  <tr><td class="no">A-06</td><td>研发费加计扣除口径说明</td><td>周敏</td><td>2026-08-15</td><td>R-2026Q2-05</td></tr>
  <tr><td class="no">A-07</td><td>Q1 遗留 2 项逾期行动项结项</td><td>沈拓（会务组）</td><td>2026-08-08</td><td>上季度纪要</td></tr>
</table>

<div class="box">
  <h2>出处与更正记录</h2>
  <p><b>R-2026Q2-03 原话</b>（转写片段 T-0142，01:08:12–01:09:30，说话人：质量总监 林知远）：「37 起异议平均压了 14.6 天，客户等不了这么久。我建议从八月一号开始，新签的合同一律写七天，老合同按原来的走完。」</p>
  <p><b>R-2026Q2-02 更正</b>（2026-07-25 10:06，更正人：生产副总 郑维）：AI 原抽取结论为「立即停止中厚板备件新增投入」，更正为「暂缓新增投入，Q3 末复盘后再定」。原结论保留在本版本附录，未删除。</p>
  <p><b>A-03 适用范围更正</b>（2026-07-25 10:06，更正人：生产副总 郑维）：由「7 天时限追溯存量合同」更正为「仅对 2026-08-01 起新签合同生效，存量合同 14 天自然过渡」。</p>
  <p><b>会后补充说明</b>：R-2026Q2-04 的责任人与到期、R-2026Q2-05 的到期，均由会议主持人于 2026-07-25 09:20 补充，会上未作明确表述，已与会上原话分层存放。</p>
</div>

<p class="foot">本版本记账：采纳 5 项 · 人工修改 2 项 · 会后补充 3 处 · 自动执行 0 项。示例内容，企业、人员与数据均为演示，不对应任何真实会议。</p>
</body></html>`;

const MINUTES_SIZE_BYTES = new TextEncoder().encode(MINUTES_HTML).length;

/** 面板底稿：会议档案 / 待办与责任人 / 协同群 / 操作留痕 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "meeting",
  foot: "已连接：钉钉 AI 听记 · 会议记录库 · 钉钉待办 · 协同群（演示）",
  views: [
    {
      key: "meeting",
      label: "会议档案",
      winTitle: "会议档案 · 2026 Q2 经营分析会",
      toolbar: { title: "2026 Q2 经营分析会", sub: "尚未读取" },
      widget: { kind: "rows", rows: [], empty: { title: "尚未读取会议听记与材料" } },
    },
    {
      key: "actions",
      label: "待办与责任人",
      winTitle: "钉钉待办 · 经营会行动项",
      toolbar: { title: "经营会行动项", sub: "尚未下发" },
      widget: {
        kind: "table",
        cols: [
          { key: "item", label: "行动项" },
          { key: "owner", label: "责任人" },
          { key: "due", label: "到期" },
          { key: "state", label: "状态", align: "right" },
        ],
        rows: [],
        empty: { title: "尚未创建任何待办" },
      },
    },
    {
      key: "group",
      label: "协同群",
      winTitle: "协同群 · Q2 经营会行动跟进",
      toolbar: { title: "Q2 经营会行动跟进群", sub: "12 人 · 尚无播报" },
      widget: { kind: "feed", items: [], empty: { title: "尚未向群内发布任何内容" } },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次会话",
      toolbar: { title: "本次会话的系统动作", sub: "0 条" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const meetingActionScript: ReplayScript = {
  scenarioId: "catalog-meeting-action-record-create",
  title: "会议事实、决定与行动引用可追溯",
  mode: "hero",
  artifacts: { [MINUTES_PATH]: MINUTES_HTML },

  steps: [
    {
      caption: "读取会议听记与随附材料",
      blocks: [
        {
          id: "m1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "把昨天经营会的决议和待办整理一下。",
        },
        {
          id: "m1-tool",
          kind: "tool_use",
          title: "MeetingTranscript",
          defaultOpen: true,
          toolName: "MeetingTranscript",
          toolId: "t-transcript",
          content: JSON.stringify({ meeting: "2026Q2-OPS", withAttachments: true }),
          executionStatus: "completed",
          durationMs: 1320,
          presentation: {
            title: "读取会议听记与随附材料",
            detail: [
              { k: "会议", v: "2026 Q2 经营分析会 · 2026-07-24 09:30–11:48" },
              { k: "听记", v: "138 分钟 · 转写 412 片段 · 说话人 7 位" },
              { tree: "├", k: "随附材料", v: "议程与经营看板 1 份 · 上季度纪要 1 份" },
              { tree: "└", k: "处理授权", v: "主持人已授权整理 · 保留期 24 个月" },
            ],
            status: "ok",
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 2026-07-24", sub: "138 分钟 · 412 片段" },
              { op: "rowInsert", view: "meeting", row: { id: "m-audio", text: "会议听记 · 138 分钟", sub: "412 个转写片段 · 7 位说话人 · 带时点", meta: "已授权" } },
              { op: "rowInsert", view: "meeting", row: { id: "m-agenda", text: "议程与经营看板.pdf", sub: "会务组 07-23 上传", meta: "2.1 MB" } },
              { op: "rowInsert", view: "meeting", row: { id: "m-last", text: "2026 Q1 经营会纪要", sub: "上季度 6 项行动项 · 结项 4 · 逾期 2", meta: "已归档" } },
              { op: "feedAppend", view: "audit", item: { id: "ma-1", from: "AI 同事", time: "09:14:22", text: "读取钉钉 AI 听记 2026Q2-OPS 与 2 份随附材料（只读）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "1 条" },
            ],
          },
        },
        {
          id: "m1-result",
          kind: "tool_result",
          title: "MeetingTranscript 结果",
          defaultOpen: false,
          toolName: "MeetingTranscript",
          toolId: "t-transcript",
          content: "meeting=2026Q2-OPS duration=138min segments=412 speakers=7 attachments=2",
        },
        {
          id: "m1-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "听记和材料都在手上了。**我不会把 412 段转写直接压成一篇通顺的文章**——按事实、决定、行动分三层抽，每一条都要能指回具体片段；抽不出来的我会原样标出来给你，而不是替你圆。",
        },
      ],
    },

    {
      caption: "抽取三层结论，主动交出缺口",
      blocks: [
        {
          id: "m2-tool",
          kind: "tool_use",
          title: "MinutesExtract",
          defaultOpen: true,
          toolName: "MinutesExtract",
          toolId: "t-extract",
          content: JSON.stringify({ meeting: "2026Q2-OPS", layers: ["fact", "decision", "action"] }),
          executionStatus: "completed",
          durationMs: 2260,
          presentation: {
            title: "按事实 / 决定 / 行动三层抽取",
            detail: [
              { section: "抽取结果" },
              { verdict: "pass", text: "事实 18 条", note: "营收 4.82 亿 · 毛利率 21.3%（同比 -2.1pt）· 质量异议 37 起，全部带片段定位" },
              { verdict: "pass", text: "决议 5 条", note: "产能上调 · 中厚板投入 · 质量异议时限 · 双源供应 · 加计扣除口径" },
              { verdict: "pass", text: "行动项 7 条", note: "其中 5 条可直接从决议派生责任人与到期" },
              { section: "主动交出的缺口" },
              { warn: "决议④ 双源供应缺责任人——会上没人认领，不替你补" },
              { warn: "决议⑤ 加计扣除口径只说了「尽快」，「尽快」不是到期日" },
              { warn: "争议 1 处：中厚板板块「停投入」还是「缓投入」，两位高管口径不一致，原样保留待裁决" },
            ],
            status: "warn",
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 抽取结果", sub: "事实 18 · 决议 5 · 行动 7 · 缺口 2" },
              { op: "rowInsert", view: "meeting", row: { id: "m-fact", text: "事实 18 条 · 全部带片段定位", sub: "营收 4.82 亿 / 毛利率 21.3% / 质量异议 37 起 / 逾期交付 12 单", state: "hit", badge: { text: "可核对", tone: "pass" } } },
              { op: "rowInsert", view: "meeting", row: { id: "m-gap", text: "2 项决议缺责任人或时限", sub: "决议④ 双源供应（无人认领）· 决议⑤ 加计扣除口径（只说了「尽快」）", tone: "warn", badge: { text: "待补", tone: "warn" } } },
              { op: "rowInsert", view: "meeting", row: { id: "m-dispute", text: "1 处口径争议未裁决", sub: "中厚板备件板块：立即停止新增投入 / 暂缓再观察一个周期", tone: "warn", badge: { text: "待裁决", tone: "pending" } } },
              { op: "feedAppend", view: "audit", item: { id: "ma-2", from: "AI 同事", time: "09:15:06", text: "三层抽取完成：事实 18 · 决议 5 · 行动 7 · 缺口 2 · 争议 1（未写入任何系统）" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "2 条" },
            ],
          },
        },
        {
          id: "m2-result",
          kind: "tool_result",
          title: "MinutesExtract 结果",
          defaultOpen: false,
          toolName: "MinutesExtract",
          toolId: "t-extract",
          content: "facts=18 decisions=5 actions=7 gaps=2 disputes=1",
        },
        {
          id: "m2-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "先说**我没做到的部分**，这两条我不替你补：",
            "",
            "1. **决议④ 双源供应** —— 会上确实定了「A 类物料改双源」，但从头到尾没人认领。转写里最接近的一句是供应链总监说「这个我们内部再对一下」，那不是责任人承诺，我不能把它写成责任人。",
            "2. **决议⑤ 研发费加计扣除口径统一** —— 有责任人（财务总监周敏），但没有任何时间点。原话是「尽快出个口径」，「尽快」不是到期日。",
            "",
            "还有一处不一致我原样留着：中厚板备件板块，生产口径是「立即停止新增投入」，供应链口径是「先缓一缓看一个周期」。这个要你们自己裁，我按争议保留，不挑一个听起来顺的写上去。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "主持人补齐缺口",
      blocks: [
        {
          id: "m3-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "双源供应那条责任人是何立（供应链总监），年底前完成第二供应商认证。加计扣除口径让周敏 8 月 15 日前给到。",
        },
        {
          id: "m3-tool",
          kind: "tool_use",
          title: "MinutesPatch",
          defaultOpen: true,
          toolName: "MinutesPatch",
          toolId: "t-patch",
          content: JSON.stringify({ record: "MIN-2026Q2-OPS", fill: ["decision-04.owner", "decision-04.due", "decision-05.due"] }),
          executionStatus: "completed",
          durationMs: 780,
          presentation: {
            title: "回填缺口并标注来源分层",
            detail: [
              { k: "决议④", v: "责任人 何立（供应链总监）· 到期 2026-12-31" },
              { k: "决议⑤", v: "到期 2026-08-15 · 责任人周敏为会上原话，未改" },
              { quote: "尽快出个口径", source: "T-0301 [02:06:31] · 会上原话，与「08-15」分层存放" },
              { tree: "├", k: "来源分层", v: "3 处补充均记为「会后补充」，与会上原话分开存放" },
              { tree: "└", k: "记录版本", v: "v0.2 草稿 · 补充人与补充时间绑定到本版本" },
            ],
            status: "ok",
            receipt: { id: "MIN-2026Q2-OPS-v0.2", system: "会议记录版本库", readBack: true },
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 抽取结果", sub: "事实 18 · 决议 5 · 行动 7 · 缺口 0" },
              { op: "rowUpdate", view: "meeting", id: "m-gap", set: { text: "2 项缺口已由主持人补齐", sub: "标注为「会后补充」，不混进会上原话", state: "hit", tone: "pass", badge: { text: "已补齐", tone: "pass" } } },
              { op: "rowInsert", view: "meeting", row: { id: "m-ver", text: "会议记录 v0.2", sub: "会后补充 3 处 · 补充人：会议主持人 · 07-25 09:20", meta: "草稿", badge: { text: "未发布", tone: "pending" } } },
              { op: "feedAppend", view: "audit", item: { id: "ma-3", from: "AI 同事", time: "09:20:41", text: "写入会议记录 v0.2 并回读校验通过：补齐 3 处，全部标记来源为会后补充" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "3 条" },
            ],
          },
        },
        {
          id: "m3-result",
          kind: "tool_result",
          title: "MinutesPatch 结果",
          defaultOpen: false,
          toolName: "MinutesPatch",
          toolId: "t-patch",
          content: "record=MIN-2026Q2-OPS version=v0.2 filled=3 provenance=post-meeting readBack=ok",
        },
        {
          id: "m3-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: "补齐了，但**这几条在纪要里会长得不一样**——会上原话挂着片段号和时间码，会后补充只挂补充人和补充时间。谁在什么时候把「尽快」变成了「8 月 15 日」，三个月后查得到。中厚板那处争议我还留着，等下一步一起定。",
        },
      ],
    },

    {
      caption: "决议编号化并挂到业务对象",
      blocks: [
        {
          id: "m4-tool",
          kind: "tool_use",
          title: "DecisionRegister",
          defaultOpen: true,
          toolName: "DecisionRegister",
          toolId: "t-register",
          content: JSON.stringify({ record: "MIN-2026Q2-OPS", prefix: "R-2026Q2" }),
          executionStatus: "completed",
          durationMs: 1480,
          presentation: {
            title: "生成稳定决议编号并挂载业务对象",
            detail: [
              { no: 1, text: "R-2026Q2-01 · QZ-9 产线三季度产能上调 15% → 挂载：排产计划 PP-2026Q3" },
              { no: 2, text: "R-2026Q2-02 · 中厚板备件板块投入策略 → 口径待裁决，暂不挂载" },
              { no: 3, text: "R-2026Q2-03 · 质量异议处理时限压缩至 7 天 → 挂载：《质量异议处理办法》+ 销售合同模板 CT-TMPL-03" },
              { no: 4, text: "R-2026Q2-04 · A 类物料双源供应 → 挂载：供应商认证流程 SUP-CERT" },
              { no: 5, text: "R-2026Q2-05 · 研发费加计扣除口径统一 → 挂载：财务口径手册 FIN-GL-07" },
              { insight: "从今天起，这场会议是可被后续场景引用的证据，不是一份存档的纪要", label: "结论" },
            ],
            status: "ok",
            receipt: { id: "REG-2026Q2-OPS", system: "决议登记簿", readBack: true },
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 决议登记", sub: "5 条决议已编号 · 挂载业务对象 4 个" },
              { op: "rowInsert", view: "meeting", row: { id: "r1", text: "决议① R-2026Q2-01 · 产能上调 15%", sub: "郑维 · 08-10 · 出处 T-0087 [00:41:33] · 挂 PP-2026Q3" } },
              { op: "rowInsert", view: "meeting", row: { id: "r2", text: "决议② R-2026Q2-02 · 中厚板备件投入策略", sub: "何立 · 待定 · 出处 T-0211 [01:35:07] · 口径未裁决", tone: "warn", badge: { text: "待裁决", tone: "pending" } } },
              { op: "rowInsert", view: "meeting", row: { id: "r3", text: "决议③ R-2026Q2-03 · 质量异议处理时限压缩至 7 天", sub: "林知远 · 07-31 · 出处 T-0142 [01:08:12] · 挂 CT-TMPL-03", state: "hit", badge: { text: "已挂合同模板", tone: "pass" } } },
              { op: "rowInsert", view: "meeting", row: { id: "r4", text: "决议④ R-2026Q2-04 · A 类物料双源供应", sub: "何立 · 12-31（会后补充）· 出处 T-0256 [01:52:44] · 挂 SUP-CERT" } },
              { op: "rowInsert", view: "meeting", row: { id: "r5", text: "决议⑤ R-2026Q2-05 · 加计扣除口径统一", sub: "周敏 · 08-15（会后补充）· 出处 T-0301 [02:06:31] · 挂 FIN-GL-07" } },
              { op: "feedAppend", view: "audit", item: { id: "ma-4", from: "AI 同事", time: "09:22:10", text: "登记 5 条决议编号 R-2026Q2-01…05，挂载 4 个业务对象并回读校验" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "4 条" },
            ],
          },
        },
        {
          id: "m4-result",
          kind: "tool_result",
          title: "DecisionRegister 结果",
          defaultOpen: false,
          toolName: "DecisionRegister",
          toolId: "t-register",
          content: "registered=5 ids=R-2026Q2-01..05 linkedObjects=4 pending=1 readBack=ok",
        },
        {
          id: "m4-text",
          kind: "text",
          title: "业务进展",
          defaultOpen: true,
          content: [
            "5 条决议现在都有了**稳定编号**，编号背后绑着三样东西：会上原话的片段定位、责任人与到期、以及被这条决议改变的业务对象。",
            "",
            "这一步的价值不在纪要本身。**决议③ · R-2026Q2-03（质量异议处理时限压缩至 7 天）**已经挂到销售合同模板 CT-TMPL-03 上了——下个月商务起草合同、客服处理异议单时，系统里出现的不再是一句无根的「按新规定 7 天」，而是一条能点进来的引用：谁在 2026-07-24 的哪一分钟、以什么身份定的，当时会上还有过什么异议。",
            "",
            "**换句话说**，这次会议从今天起是可被后续场景引用的证据。第 7 步我会拿一份真实起草中的合同当场验一遍这条引用通不通。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "有权人确认下发",
      blocks: [],
      approval: {
        title: "下发待办并发布纪要 · 需有权人确认",
        description: "确认后才会创建钉钉待办、发布纪要版本并向协同群播报。这一步会改变业务系统，必须由有权人明确确认。",
        facts: [
          { label: "会议记录", value: "MIN-2026Q2-OPS v0.2 · 决议 5 条" },
          { label: "待创建待办", value: "7 条 · 覆盖 6 位责任人" },
          { label: "待裁决", value: "1 处口径争议（中厚板板块）" },
          { label: "发布范围", value: "跟进群 12 人 + 责任人钉钉待办" },
        ],
        approveLabel: "确认下发",
        rejectLabel: "退回修改",
        approvedBlocks: [
          {
            id: "m5-human",
            kind: "prompt",
            title: "用户消息",
            defaultOpen: true,
            content: "两处要改。第一，中厚板那条别写「立即停止新增投入」，改成暂缓、Q3 末复盘后再定——会上我说急了，落到纸上得是这个口径。第二，第 3 条待办的 7 天只对 8 月 1 日起新签合同生效，存量合同维持 14 天自然过渡，别一刀切追溯，客服和商务会炸。其余照你写的发。",
          },
          {
            id: "m5-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-approve",
            content: JSON.stringify({ record: "MIN-2026Q2-OPS", decision: "approved", edits: 2 }),
            executionStatus: "completed",
            durationMs: 340,
            presentation: {
              title: "下发已确认 · 含人工修改 2 项",
              detail: [
                { k: "审批结果", v: "确认下发" },
                { k: "记账", v: "采纳 5 项 · 修改 2 项 · 自动执行 0 项" },
                { no: 1, text: "决议② 由「立即停止中厚板备件新增投入」改为「暂缓新增投入，Q3 末复盘后再定」" },
                { no: 2, text: "待办 A-03 由「7 天时限追溯存量合同」改为「仅对 2026-08-01 起新签合同生效」" },
                { tree: "└", k: "留痕", v: "AI 原结论、修改人、修改时间与生效版本 v1.0 一并记录，原结论不删除" },
              ],
              status: "ok",
              receipt: { id: "APR-2026Q2-OPS-01", system: "审批中心", readBack: true },
              panel: [
                { op: "focus", view: "meeting" },
                { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 决议登记", sub: "5 条决议 · 人工修改 2 项 · 待裁决 0" },
                { op: "rowUpdate", view: "meeting", id: "r2", set: { text: "决议② R-2026Q2-02 · 中厚板备件暂缓新增投入", sub: "何立 · Q3 末复盘 09-30 · 生产副总修改（原：立即停止新增投入）", tone: "pass", badge: { text: "人工修改", tone: "warn" } } },
                { op: "rowUpdate", view: "meeting", id: "m-dispute", set: { text: "口径争议已裁决", sub: "生产副总定：暂缓，不是停止；AI 原结论一并留档", state: "hit", tone: "pass", badge: { text: "已裁决", tone: "pass" } } },
                { op: "rowUpdate", view: "meeting", id: "m-ver", set: { text: "会议记录 v1.0（发布版）", sub: "人工修改 2 项 · 修改人：生产副总 郑维 · 07-25 10:06", meta: "已定稿", badge: { text: "定稿", tone: "pass" } } },
                { op: "feedAppend", view: "audit", item: {
                  id: "ma-5",
                  from: "生产副总 郑维",
                  time: "10:06:12",
                  text: "确认下发：采纳 5 项、修改 2 项（决议②口径、待办 A-03 适用范围）、自动执行 0 项",
                  card: { title: "人审记录", body: "采纳 5 · 修改 2 · 自动执行 0；AI 原结论保留在 v1.0 附录", meta: [{ text: "AI 未自行下发", tone: "pass" }, { text: "原结论已留档", tone: "info" }] },
                } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "m5-text",
            kind: "text",
            title: "审批结果",
            defaultOpen: true,
            content: "两处都按你的口径改了，改动本身也进了账。**AI 的原结论没有被覆盖掉**——它和你的修改并排存在 v1.0 里。三个月后有人追问「当初为什么没停」，翻得到是谁在哪一刻改的、改的是哪一句。",
          },
        ],
        rejectedBlocks: [
          {
            id: "m5-rejected-tool",
            kind: "tool_use",
            title: "Approval",
            defaultOpen: true,
            toolName: "Approval",
            toolId: "t-reject",
            content: JSON.stringify({ record: "MIN-2026Q2-OPS", decision: "rejected" }),
            executionStatus: "completed",
            durationMs: 260,
            presentation: {
              title: "下发被退回 · 没有任何东西发出去",
              detail: [
                { k: "审批结果", v: "退回修改" },
                { k: "钉钉待办", v: "未创建 · 0 条" },
                { k: "会议纪要", v: "未发布 · 停在 v0.2 草稿" },
                { k: "协同群", v: "未播报 · 12 人无感知" },
                { tree: "└", k: "留痕", v: "退回人、退回时间与当时记录版本已记账，等待重新提交" },
              ],
              status: "blocked",
              panel: [
                { op: "focus", view: "actions" },
                { op: "toolbar", view: "actions", title: "经营会行动项", sub: "未下发 · 退回已记账" },
                { op: "toolbar", view: "group", title: "Q2 经营会行动跟进群", sub: "12 人 · 未播报" },
                { op: "rowUpdate", view: "meeting", id: "m-ver", set: { sub: "审批退回，停在 v0.2 草稿 · 退回时间 07-25 10:06", tone: "warn", badge: { text: "已退回", tone: "warn" } } },
                { op: "feedAppend", view: "audit", item: { id: "ma-reject", from: "生产副总 郑维", time: "10:06:12", text: "下发被退回：待办未创建、纪要未发布、群未播报，记录停在 v0.2" } },
                { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "5 条" },
              ],
            },
          },
          {
            id: "m5-rejected-text",
            kind: "text",
            title: "退回说明",
            defaultOpen: true,
            content: "已经停住了：待办 0 条、纪要停在 v0.2 草稿、协同群没收到任何播报，12 位参会人对此无感知。退回这件事本身也记了账——谁退的、什么时候退的、退的是哪一版。你把口径改完我重新出稿，仍然要你再确认一次，我不会因为「上次已经看过」就自动放行。",
          },
        ],
      },
    },

    {
      caption: "下发待办并发布纪要",
      blocks: [
        // 一次确认放行三个系统动作：待办 / 版本库 / 群播报——
        // 拆成三条执行行，每一条都有自己的回执，客户看得见「AI 在动哪个系统」
        {
          id: "m6-todo",
          kind: "tool_use",
          title: "TodoDispatch",
          defaultOpen: true,
          toolName: "TodoDispatch",
          toolId: "t-dispatch",
          content: JSON.stringify({ record: "MIN-2026Q2-OPS", version: "v1.0", todos: 7 }),
          executionStatus: "completed",
          durationMs: 1180,
          presentation: {
            title: "创建钉钉待办 · 7 条 · 6 位责任人",
            detail: [
              { k: "创建", v: "A-01 … A-07 · 逐条回读校验通过 · 无重复创建" },
              { k: "口径标记", v: "A-02 口径已修改 · A-03 范围已修改（随待办可见）" },
              { tree: "└", k: "到期提醒", v: "到期前 3 天提醒责任人，逾期升级至会议主持人" },
            ],
            status: "ok",
            receipt: { id: "TODO-2026Q2-OPS-7", system: "钉钉待办", readBack: true },
            panel: [
              { op: "focus", view: "actions" },
              { op: "toolbar", view: "actions", title: "经营会行动项 · 已下发", sub: "7 条 · 已接收 7 · 逾期 0" },
              { op: "tableRowInsert", view: "actions", row: { id: "a01", cells: { item: "A-01 QZ-9 三季度排产方案", owner: "郑维（生产副总）", due: "08-10", state: "已接收" } } },
              { op: "tableRowInsert", view: "actions", row: { id: "a02", cells: { item: "A-02 中厚板板块 Q3 末复盘材料", owner: "何立（供应链总监）", due: "09-30", state: "已接收" } } },
              { op: "cellFlag", view: "actions", rowId: "a02", colKey: "state", tone: "warn", flag: "口径已修改" },
              { op: "tableRowInsert", view: "actions", row: { id: "a03", cells: { item: "A-03 修订《质量异议处理办法》至 7 天", owner: "林知远（质量总监）", due: "07-31", state: "已接收" } } },
              { op: "cellFlag", view: "actions", rowId: "a03", colKey: "state", tone: "warn", flag: "范围已修改" },
              { op: "tableRowInsert", view: "actions", row: { id: "a04", cells: { item: "A-04 合同模板 CT-TMPL-03 同步 7 天条款", owner: "徐岚（商务部）", due: "08-05", state: "已接收" } } },
              { op: "tableRowInsert", view: "actions", row: { id: "a05", cells: { item: "A-05 A 类物料第二供应商认证", owner: "何立（供应链总监）", due: "12-31", state: "已接收" } } },
              { op: "tableRowInsert", view: "actions", row: { id: "a06", cells: { item: "A-06 研发费加计扣除口径说明", owner: "周敏（财务总监）", due: "08-15", state: "已接收" } } },
              { op: "tableRowInsert", view: "actions", row: { id: "a07", cells: { item: "A-07 Q1 遗留 2 项逾期行动项结项", owner: "沈拓（会务组）", due: "08-08", state: "已接收" } } },
            ],
          },
        },
        {
          id: "m6-todo-result",
          kind: "tool_result",
          title: "TodoDispatch 结果",
          defaultOpen: false,
          toolName: "TodoDispatch",
          toolId: "t-dispatch",
          content: "todos=7 accepted=7 duplicates=0 readBack=ok",
        },
        {
          id: "m6-publish",
          kind: "tool_use",
          title: "MinutesPublish",
          defaultOpen: false,
          toolName: "MinutesPublish",
          toolId: "t-publish",
          content: JSON.stringify({ record: "MIN-2026Q2-OPS", version: "v1.0" }),
          executionStatus: "completed",
          durationMs: 460,
          presentation: {
            title: "发布会议纪要 v1.0",
            detail: [
              { k: "版本", v: "v0.2 草稿 → v1.0 发布版" },
              { tree: "└", k: "随版本留存", v: "人工修改 2 项 · AI 原结论在附录 · 修改人与时间绑定" },
            ],
            status: "ok",
            receipt: { id: "MIN-2026Q2-OPS-v1.0", system: "会议记录版本库", readBack: true },
          },
        },
        {
          id: "m6-broadcast",
          kind: "tool_use",
          title: "GroupBroadcast",
          defaultOpen: false,
          toolName: "GroupBroadcast",
          toolId: "t-broadcast",
          content: JSON.stringify({ group: "Q2 经营会行动跟进", card: "decision-summary" }),
          executionStatus: "completed",
          durationMs: 380,
          presentation: {
            title: "向跟进群播报决议卡 · 12 人",
            detail: [
              { k: "播报内容", v: "纪要 v1.0 发布通知 + 决议卡 1 张（标注含人工修改 2 项）" },
            ],
            status: "ok",
            receipt: { id: "IM-2026Q2-OPS-1", system: "钉钉群", readBack: true },
            panel: [
              { op: "toolbar", view: "group", title: "Q2 经营会行动跟进群", sub: "12 人 · 1 条播报" },
              { op: "feedAppend", view: "group", item: {
                id: "mg-1",
                from: "AI 同事",
                time: "10:07:35",
                text: "@全体成员 2026 Q2 经营分析会纪要 v1.0 已发布，7 条行动项已按责任人下发到各位待办。",
                card: { title: "Q2 经营会 · 决议与行动项", body: "决议 5 条 · 行动项 7 条 · 最近到期 07-31（A-03 质量异议办法修订）", meta: [{ text: "v1.0 已发布", tone: "pass" }, { text: "含人工修改 2 项", tone: "warn" }] },
              } },
              { op: "feedAppend", view: "audit", item: { id: "ma-6", from: "AI 同事", time: "10:07:35", text: "创建 7 条钉钉待办并逐条回读；发布纪要 v1.0；向跟进群播报 1 条决议卡" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "6 条" },
            ],
          },
        },
        {
          id: "m6-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "待办已经躺进各位责任人的钉钉里了。**下面这份就是参会人此刻点开看到的那一份纪要**，决议表、行动项表和出处段落都在里面，可以先自己核一遍：",
            "",
            `[FILE]{"filePath":"${MINUTES_PATH}","fileName":"远洲重工Q2经营会纪要.html","fileSize":${MINUTES_SIZE_BYTES}}[/FILE]`,
            "",
            "两处被你改过的地方在纪要里是带标记的，群里那张决议卡也写着「含人工修改 2 项」——参会人看到的版本和你批的版本是同一份，不存在对内一套、对外一套。",
            "",
            "上季度那 2 条没人管的逾期行动项，我一并挂了 A-07 给会务组结项。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "商务侧反查这条决议",
      blocks: [
        {
          id: "m7-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "（同日 15:42 · 商务部）我在起草给北屿装备的新合同 CT-2026-0913，质量异议条款到底写 14 天还是 7 天？谁定的？",
        },
        {
          id: "m7-tool",
          kind: "tool_use",
          title: "DecisionLookup",
          defaultOpen: true,
          toolName: "DecisionLookup",
          toolId: "t-lookup",
          content: JSON.stringify({ contract: "CT-2026-0913", clause: "quality-objection-sla" }),
          executionStatus: "completed",
          durationMs: 690,
          presentation: {
            title: "合同条款反查决议出处",
            detail: [
              { k: "查询对象", v: "销售合同 CT-2026-0913 · 质量异议处理条款" },
              { k: "命中决议", v: "R-2026Q2-03 · 处理时限 7 天" },
              { quote: "37 起异议平均压了 14.6 天，客户等不了这么久。我建议从八月一号开始，新签的合同一律写七天，老合同按原来的走完。", source: "T-0142 [01:08:12] · 质量总监 林知远" },
              { verdict: "pass", text: "适用判定", note: "本合同签署日 2026-08-04 ≥ 生效日 2026-08-01 → 适用 7 天" },
              { verdict: "warn", text: "同时带出", note: "生产副总 07-25 的范围修改：存量合同不追溯" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "meeting" },
              { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 决议登记", sub: "5 条决议 · 下游引用 1 次" },
              { op: "rowUpdate", view: "meeting", id: "r3", set: { sub: "林知远 · 07-31 · 出处 T-0142 [01:08:12] · 已被合同 CT-2026-0913 引用", state: "hit", tone: "pass", badge: { text: "被引用 ×1", tone: "pass" } } },
              { op: "feedAppend", view: "audit", item: {
                id: "ma-7",
                from: "AI 同事",
                time: "15:42:18",
                text: "商务侧反查 R-2026Q2-03：返回条款口径、生效边界与会议出处，引用关系双向登记",
                card: { title: "跨场景引用已建立", body: "合同 CT-2026-0913 ← R-2026Q2-03 ← 2026 Q2 经营会 T-0142 [01:08:12]", meta: [{ text: "可指回原话", tone: "pass" }, { text: "双向可查", tone: "info" }] },
              } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "7 条" },
            ],
          },
        },
        {
          id: "m7-result",
          kind: "tool_result",
          title: "DecisionLookup 结果",
          defaultOpen: false,
          toolName: "DecisionLookup",
          toolId: "t-lookup",
          content: "hit=R-2026Q2-03 sla=7d effectiveFrom=2026-08-01 applies=true source=2026Q2-OPS#T-0142 amendedBy=郑维@2026-07-25",
        },
        {
          id: "m7-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "合同里写 **7 天**，但要带上适用范围那句话。",
            "",
            "这个答案不是我现推的，是从 **R-2026Q2-03** 这条决议直接取回来的。它 07-25 挂到了合同模板 CT-TMPL-03 上，你今天起草时反查，拿回来的除了「7 天」这个数字，还有三样东西——2026-07-24 会上第 68 分钟质量总监的原话、8 月 1 日起对新签合同生效的边界、以及生产副总在纪要定稿时加的「存量合同不追溯」。你这份合同签署日 08-04，落在生效边界之后，所以适用。",
            "",
            "反过来也成立：右侧决议③ 现在带上了「被引用 ×1」。往后有人问这份合同为什么是 7 天，从合同能一路点回那场会议的那一分钟；从会议也能看清它究竟影响了哪几份合同。**这就是「企业记忆」的实际含义**——不是把纪要存起来，是让后面每一次决定都能指回它的依据。",
          ].join("\n"),
        },
      ],
    },

    {
      caption: "跨系统核对终态",
      blocks: [
        {
          id: "m8-tool",
          kind: "tool_use",
          title: "ReadBack",
          defaultOpen: true,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: JSON.stringify({ record: "MIN-2026Q2-OPS", version: "v1.0" }),
          executionStatus: "completed",
          durationMs: 1150,
          presentation: {
            title: "回读四个系统，核对说法是否一致",
            detail: [
              { k: "回读方式", v: "按对象 ID 逐个反查，不用本次会话的缓存" },
              { verdict: "pass", text: "会议记录库", note: "返回 v1.0，文件校验与发布版一致" },
              { verdict: "pass", text: "决议登记簿", note: "5 条编号均可解析，其中 1 条已有下游引用" },
              { verdict: "pass", text: "钉钉待办", note: "7 条状态为已接收，无重复创建" },
              { verdict: "pass", text: "协同群", note: "播报 1 条，内容与 v1.0 决议表逐条比对一致" },
              { insight: "四方一致，无未决动作", label: "结论" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "audit" },
              { op: "toolbar", view: "meeting", title: "2026 Q2 经营分析会 · 终态回读", sub: "5 条决议 · 下游引用 1 次 · 四方一致" },
              { op: "feedAppend", view: "audit", item: { id: "ma-8", from: "AI 同事", time: "15:42:50", text: "回读会议记录库 / 决议登记簿 / 钉钉待办 / 协同群，四方状态一致，无未决任务" } },
              { op: "toolbar", view: "audit", title: "本次会话的系统动作", sub: "8 条" },
            ],
          },
        },
        {
          id: "m8-result",
          kind: "tool_result",
          title: "ReadBack 结果",
          defaultOpen: false,
          toolName: "ReadBack",
          toolId: "t-readback",
          content: "minutes=v1.0 decisions=5 refs=1 todos=7/7 accepted broadcast=1 consistent=true pending=0",
        },
        {
          id: "m8-text",
          kind: "text",
          title: "本次会话改变了什么",
          defaultOpen: true,
          content: [
            "## 本次会话改变了什么",
            "",
            "| 系统 | 终态 | 依据 |",
            "| --- | --- | --- |",
            "| 会议记录库 | MIN-2026Q2-OPS 从 v0.2 草稿定稿为 v1.0 | 修改人、修改时间与原结论同版留存 |",
            "| 决议登记簿 | R-2026Q2-01…05 五条稳定编号 | 每条绑定转写片段定位与业务对象 |",
            "| 钉钉待办 | 7 条已下发并回读，6 位责任人已接收 | 到期前 3 天提醒、逾期升级主持人 |",
            "| 协同群 | 1 条决议播报，12 人可见 | 决议卡标注「含人工修改 2 项」 |",
            "| 销售合同模板 | CT-TMPL-03 关联 R-2026Q2-03 | 商务起草 CT-2026-0913 时反查即命中 |",
            "",
            "## 本次会话没有做什么",
            "",
            "- 没有替你补缺口：决议④ 的责任人、决议⑤ 的时限都是主持人补的，且单独标为「会后补充」，不与会上原话混放；",
            "- 没有自行裁决争议：中厚板板块「停」还是「缓」由生产副总定，AI 的原结论保留在 v1.0 附录里，没有被删掉；",
            "- 没有自动下发：待办创建、纪要发布、群播报三件事卡在同一个确认点后面，自动执行 0 项；",
            "- 没有改动上季度记录：Q1 纪要与那 2 条逾期行动项只被读取和引用，原文一个字没动；",
            "- 没有对外发送：合同 CT-2026-0913 只做了条款反查，草稿未修改、未发给客户。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离
  sources: [
    {
      blockRef: "step1.tool.MeetingTranscript",
      producer: "钉钉 AI 听记（DWS 连接）",
      state: "needs-change",
      gap: "DWS 已能取到听记文本，但返回里没有「片段编号 + 起止时间 + 说话人 + 置信度」的结构化字段，出处定位要靠产品侧自建片段索引；且不产出 presentation",
    },
    {
      blockRef: "step2.tool.MinutesExtract",
      producer: "会议纪要抽取器（事实 / 决定 / 行动三层）",
      state: "missing",
      gap: "三层分类与「缺口判定」当前完全靠 Agent 临场推理，没有可版本化的抽取规则、置信阈值与缺口清单结构；抽取结果不落库，换个会话就没了",
    },
    {
      blockRef: "step3.tool.MinutesPatch",
      producer: "会议记录版本库",
      state: "missing",
      gap: "「会上原话 / 会后补充」的来源分层、版本号与补充人绑定需要一个会议记录对象；产品里既没有该对象，也没有版本机制",
    },
    {
      blockRef: "step4.tool.DecisionRegister",
      producer: "决议登记簿（稳定编号 + 业务对象挂载）",
      state: "missing",
      gap: "这是「企业记忆」的核心存储，产品里完全不存在。没有它第 7 步的跨场景引用无从谈起；也是本剧本最贵的一块",
    },
    {
      blockRef: "step5.tool.Approval",
      producer: "业务审批执行器",
      state: "needs-change",
      gap: "HITL 审批事件在 runtime 已成对记录，但「人改了哪一条、原结论是什么、改成什么」没有结构化字段，只能落在自由文本里",
    },
    {
      blockRef: "step5.tool.Approval(reject)",
      producer: "业务审批执行器（退回分支）",
      state: "needs-change",
      gap: "退回分支只有事件记录，缺「本次退回时对象停在哪一版」的快照绑定，重新提交时无法自动 diff 出改了什么",
    },
    {
      blockRef: "step6.tool.TodoDispatch",
      producer: "钉钉待办（DWS 连接）",
      state: "needs-change",
      gap: "DWS 可创建待办，但「待办 ↔ 决议编号」的反向索引与写后回读回执都不存在，到期提醒和逾期升级也没有产品化配置",
    },
    {
      blockRef: "step6.tool.MinutesPublish",
      producer: "会议记录版本库",
      state: "missing",
      gap: "同 step3：版本对象与发布机制在产品里不存在，v0.2→v1.0 的定稿动作无处落",
    },
    {
      blockRef: "step6.tool.GroupBroadcast",
      producer: "钉钉群机器人（DWS 连接）",
      state: "needs-change",
      gap: "DWS 可发群消息，但决议卡模板与「播报内容 ↔ 纪要版本」的绑定校验不存在，播报后不回读",
    },
    {
      blockRef: "step7.tool.DecisionLookup",
      producer: "决议引用探针",
      state: "missing",
      gap: "依赖第 4 步的决议登记簿；在此之前跨场景引用只能靠人翻纪要，这一屏是演示与真实差距最大的地方",
    },
    {
      blockRef: "step8.tool.ReadBack",
      producer: "业务终态回读器",
      state: "missing",
      gap: "跨系统回读要先有各系统连接器与稳定对象 ID；在此之前终态核对表只能人工整理",
    },
    {
      blockRef: "step6.artifact.远洲重工Q2经营会纪要",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};
