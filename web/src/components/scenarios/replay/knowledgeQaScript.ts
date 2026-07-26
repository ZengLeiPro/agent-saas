import type { SystemPanelSnapshot } from "@agent/shared";
import type { ReplayScript } from "./types";

/**
 * 首个演示剧本：制度知识问答。
 *
 * 选它作为第一份，是因为它用最少的块打通全链路——工具摘要、多轮工具、
 * 正文答复、[FILE] 产物挂右侧面板——便于验证底层，而不是因为它最好看。
 *
 * 内容为虚构示例，不对应任何真实企业制度。
 */

const CITATION_PANEL_PATH = "assets/demo/制度条款引用.html";

const CITATION_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --brand: #2E56E1; --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.7 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color: var(--ink); background: #fff; }
  h1 { margin: 0 0 4px; font-size: 15px; }
  .sub { margin: 0 0 18px; color: var(--muted); font-size: 12px; }
  .doc { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .doc-h { display: flex; align-items: baseline; gap: 8px; padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid var(--line); }
  .doc-t { font-weight: 600; font-size: 13px; }
  .doc-m { color: var(--muted); font-size: 12px; margin-left: auto; }
  .clause { padding: 12px; border-bottom: 1px dashed var(--line); }
  .clause:last-child { border-bottom: 0; }
  .clause-n { color: var(--brand); font-weight: 600; font-size: 12px; margin-bottom: 4px; }
  .hit { background: rgba(46, 86, 225, .1); padding: 0 2px; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
  th { background: #f8fafc; color: var(--muted); font-weight: 500; }
  .foot { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body>
<h1>制度条款引用</h1>
<p class="sub">本次答复引用的原文位置，供核对</p>

<div class="doc">
  <div class="doc-h"><span class="doc-t">差旅管理办法</span><span class="doc-m">2026 修订版 · 制度中心</span></div>
  <div class="clause">
    <div class="clause-n">第四章 第 12 条 住宿标准</div>
    <div>员工因公出差，住宿费按出差目的地城市档位与本人职级分档控制，<span class="hit">一类城市职级 P5 及以下每晚上限 600 元</span>，超出部分需在报销单说明原因并经部门负责人审批。</div>
    <table>
      <tr><th>城市档位</th><th>P5 及以下</th><th>P6–P7</th></tr>
      <tr><td>一类（北上广深）</td><td>600 元/晚</td><td>800 元/晚</td></tr>
      <tr><td>二类（省会及计划单列市）</td><td>450 元/晚</td><td>600 元/晚</td></tr>
    </table>
  </div>
  <div class="clause">
    <div class="clause-n">第四章 第 15 条 票据要求</div>
    <div>住宿费须提供住宿业增值税发票，<span class="hit">发票抬头须与公司主体一致</span>，行程单与发票日期须能相互印证。</div>
  </div>
</div>

<div class="doc">
  <div class="doc-h"><span class="doc-t">费用报销操作指引</span><span class="doc-m">2025-11 发布 · 制度中心</span></div>
  <div class="clause">
    <div class="clause-n">第 3 节 提交时限</div>
    <div>差旅费用应于行程结束后 <span class="hit">30 个自然日内</span>提交报销申请，逾期需附情况说明。</div>
  </div>
</div>

<p class="foot">示例内容，不对应任何真实企业制度。</p>
</body></html>`;

const CITATION_PANEL_SIZE_BYTES = new TextEncoder().encode(CITATION_PANEL_HTML).length;

/**
 * 面板底稿：三个被触达的企业系统视图。
 * 初始状态是"还没被检索过"的样子——每一步的 patch 才让它动起来。
 */
const PANEL_BASE: SystemPanelSnapshot = {
  title: "企业系统实况",
  live: true,
  activeView: "kb",
  foot: "已连接：制度中心 · 通讯录（只读）",
  views: [
    {
      key: "kb",
      label: "制度中心",
      winTitle: "制度中心 · 文档库",
      toolbar: { title: "制度中心 · 文档库", sub: "共 5 篇" },
      widget: {
        kind: "rows",
        rows: [
          { id: "doc-travel", text: "差旅管理办法(2026).md", sub: "2026 修订版 · 财务", meta: "18 KB" },
          { id: "doc-expense", text: "费用报销操作指引(2025-11).md", sub: "2025-11 发布 · 财务", meta: "24 KB" },
          { id: "doc-finance", text: "财务制度总则.md", sub: "2024 版 · 财务", meta: "31 KB" },
          { id: "doc-handbook", text: "员工手册(2025).md", sub: "2025 版 · 行政", meta: "56 KB" },
          { id: "doc-purchase", text: "采购管理办法.md", sub: "2025 版 · 供应链", meta: "22 KB" },
        ],
      },
    },
    {
      key: "profile",
      label: "通讯录",
      winTitle: "组织通讯录 · 本人档案",
      toolbar: { title: "本人档案", sub: "只读" },
      widget: { kind: "stats", cols: 3, items: [] },
    },
    {
      key: "audit",
      label: "操作留痕",
      winTitle: "操作留痕 · 本次会话",
      toolbar: { title: "本次会话的系统动作", sub: "全部只读" },
      widget: { kind: "feed", items: [], empty: { title: "尚无系统动作" } },
    },
  ],
};

export const knowledgeQaScript: ReplayScript = {
  scenarioId: "catalog-evidence-backed-communication-create",
  title: "有出处、数字不走样的业务答复",
  mode: "quick",
  artifacts: { [CITATION_PANEL_PATH]: CITATION_PANEL_HTML },

  steps: [
    {
      caption: "员工提问",
      blocks: [
        {
          id: "s1-prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "我下周去上海出差三天，住宿能报多少？发票有什么要求吗？",
        },
      ],
    },
    {
      caption: "检索制度库",
      blocks: [
        {
          id: "s2-tool",
          kind: "tool_use",
          title: "KnowledgeSearch",
          defaultOpen: false,
          toolName: "KnowledgeSearch",
          toolId: "t-search",
          content: JSON.stringify({ query: "差旅 住宿 标准 发票", scope: "制度中心" }),
          executionStatus: "completed",
          durationMs: 1840,
          presentation: {
            title: "检索企业制度库",
            detail: [
              { k: "检索范围", v: "制度中心 · 财务与行政" },
              { k: "命中文档", v: "3 篇" },
              { tree: "├", k: "最相关", v: "《差旅管理办法》2026 修订版" },
              { tree: "└", k: "次相关", v: "《费用报销操作指引》2025-11" },
            ],
            // 面板底稿只在第一条带它的摘要上生效——面板随第一次工具执行出现，
            // 这与真实会话一致（用户刚提问时确实还没有任何系统被触达）
            panelBase: PANEL_BASE,
            panel: [
              { op: "focus", view: "kb" },
              { op: "toolbar", view: "kb", title: "制度中心 · 财务与行政", sub: "命中 3 / 共 5 篇" },
              { op: "rowsUpdate", view: "kb", ids: ["doc-travel", "doc-expense"], set: { state: "hit", badge: { text: "命中", tone: "pass" } } },
              { op: "rowUpdate", view: "kb", id: "doc-finance", set: { badge: { text: "弱相关", tone: "info" } } },
              { op: "rowsUpdate", view: "kb", ids: ["doc-handbook", "doc-purchase"], set: { state: "excluded", badge: { text: "未命中", tone: "pending" } } },
              { op: "feedAppend", view: "audit", item: { id: "a1", from: "AI 同事", time: "10:24:01", text: "检索制度中心：差旅 住宿 标准 发票" } },
            ],
          },
        },
        {
          id: "s2-result",
          kind: "tool_result",
          title: "KnowledgeSearch 结果",
          defaultOpen: false,
          toolName: "KnowledgeSearch",
          toolId: "t-search",
          content: "hits=3\n1. 差旅管理办法(2026).md  score=0.91\n2. 费用报销操作指引(2025-11).md  score=0.77\n3. 财务制度总则.md  score=0.42",
        },
        {
          id: "s2-text",
          kind: "text",
          title: "检索结果",
          defaultOpen: true,
          content: "已锁定 3 篇候选制度，下一步只读取最相关制度中的住宿与票据条款。",
        },
      ],
    },
    {
      caption: "定位适用条款",
      blocks: [
        {
          id: "s3-tool",
          kind: "tool_use",
          title: "Read",
          defaultOpen: false,
          toolName: "Read",
          toolId: "t-read",
          content: JSON.stringify({ file_path: "制度中心/差旅管理办法(2026).md", offset: 120, limit: 60 }),
          executionStatus: "completed",
          durationMs: 620,
          presentation: {
            title: "定位住宿标准与票据条款",
            detail: [
              { k: "文档", v: "差旅管理办法 2026 修订版" },
              { tree: "├", k: "住宿标准", v: "第四章 第 12 条" },
              { tree: "└", k: "票据要求", v: "第四章 第 15 条" },
              { indent: 0, text: "→ 标准按「城市档位 × 本人职级」分档，需先确认职级" },
            ],
            panel: [
              { op: "toolbar", view: "kb", title: "差旅管理办法 2026 · 条款定位", sub: "命中 2 条" },
              { op: "rowInsert", view: "kb", row: { id: "c12", text: "第四章 第 12 条 住宿标准", sub: "一类城市 P5 及以下 600 元/晚", state: "hit", badge: { text: "适用", tone: "pass" } }, at: 1 },
              { op: "rowInsert", view: "kb", row: { id: "c15", text: "第四章 第 15 条 票据要求", sub: "住宿业增值税发票，抬头须与公司主体一致", state: "hit", badge: { text: "适用", tone: "pass" } }, at: 2 },
              { op: "feedAppend", view: "audit", item: { id: "a2", from: "AI 同事", time: "10:24:03", text: "读取《差旅管理办法(2026)》第四章 12/15 条" } },
            ],
          },
        },
        {
          id: "s3-result",
          kind: "tool_result",
          title: "Read 结果",
          defaultOpen: false,
          toolName: "Read",
          toolId: "t-read",
          content: "第四章 第 12 条 住宿标准\n员工因公出差，住宿费按出差目的地城市档位与本人职级分档控制……",
        },
        {
          id: "s3-text",
          kind: "text",
          title: "条款定位",
          defaultOpen: true,
          content: "已定位第 12 条住宿标准与第 15 条票据要求。金额取决于城市档位和本人职级。",
        },
      ],
    },
    {
      caption: "核对提问人职级",
      blocks: [
        {
          id: "s4-tool",
          kind: "tool_use",
          title: "DingtalkContact",
          defaultOpen: false,
          toolName: "DingtalkContact",
          toolId: "t-contact",
          content: JSON.stringify({ action: "self" }),
          executionStatus: "completed",
          durationMs: 940,
          presentation: {
            title: "核对提问人职级与归属",
            detail: [
              { k: "部门", v: "市场部" },
              { k: "职级", v: "P5" },
              { tree: "└", k: "适用档位", v: "一类城市 · P5 及以下" },
            ],
            status: "ok",
            panel: [
              { op: "focus", view: "profile" },
              { op: "statsSet", view: "profile", items: [
                { k: "部门", v: "市场部" },
                { k: "职级", v: "P5" },
                { k: "出差城市", v: "上海（一类）" },
                { k: "住宿上限", v: "600 元/晚", tone: "pass" },
                { k: "行程天数", v: "3 天" },
                { k: "合计上限", v: "1,800 元", tone: "pass" },
              ] },
              { op: "feedAppend", view: "audit", item: { id: "a3", from: "AI 同事", time: "10:24:04", text: "读取通讯录：本人部门与职级（只读）" } },
            ],
          },
        },
        {
          id: "s4-result",
          kind: "tool_result",
          title: "DingtalkContact 结果",
          defaultOpen: false,
          toolName: "DingtalkContact",
          toolId: "t-contact",
          content: '{"dept":"市场部","level":"P5"}',
        },
        {
          id: "s4-text",
          kind: "text",
          title: "适用标准",
          defaultOpen: true,
          content: "适用档位已确认：上海（一类城市）× P5，住宿上限 600 元/晚，三天合计 1,800 元。",
        },
      ],
    },
    {
      caption: "生成条款出处并答复",
      blocks: [
        {
          id: "s5-tool",
          kind: "tool_use",
          title: "Write",
          defaultOpen: false,
          toolName: "Write",
          toolId: "t-write",
          content: JSON.stringify({ file_path: CITATION_PANEL_PATH }),
          executionStatus: "completed",
          durationMs: 1120,
          presentation: {
            title: "生成条款出处清单",
            detail: [
              { k: "产物", v: "条款出处清单（HTML）" },
              { tree: "├", k: "引用条款", v: "2 条（第 12 / 15 条）" },
              { tree: "└", k: "另附", v: "报销提交时限 30 日" },
            ],
            panel: [
              { op: "focus", view: "audit" },
              { op: "feedAppend", view: "audit", item: {
                id: "a4",
                from: "AI 同事",
                time: "10:24:06",
                text: "生成条款出处清单并附于答复",
                card: { title: "条款出处清单已生成", body: "引用《差旅管理办法(2026)》第 12/15 条、《费用报销操作指引》第 3 节", meta: [{ text: "只读引用", tone: "pass" }, { text: "未修改任何系统", tone: "info" }] },
              } },
            ],
          },
        },
        {
          id: "s5-result",
          kind: "tool_result",
          title: "Write 结果",
          defaultOpen: false,
          toolName: "Write",
          toolId: "t-write",
          content: `written: ${CITATION_PANEL_PATH} (2.4 KB)`,
        },
        {
          id: "s5-text",
          kind: "text",
          title: "回复",
          defaultOpen: true,
          content: [
            "按你的职级（P5）和目的地（上海，一类城市），**住宿费上限是每晚 600 元**，三天合计 1,800 元。超出部分需要在报销单里写明原因，并经市场部负责人审批。",
            "",
            "发票有两条硬要求：",
            "1. 必须是住宿业增值税发票，抬头与公司主体一致；",
            "2. 行程单与发票日期要能相互印证。",
            "",
            "另外提醒时限：**行程结束后 30 个自然日内**提交报销，逾期要附情况说明。",
            "",
            "条款原文我整理在右侧，可直接核对：",
            "",
            `[FILE]{"filePath":"${CITATION_PANEL_PATH}","fileName":"制度条款引用.html","fileSize":${CITATION_PANEL_SIZE_BYTES}}[/FILE]`,
            "",
            "## 本次会话完成了什么",
            "",
            "- 给出与本人职级、目的地匹配的住宿金额；",
            "- 核对发票要求和报销时限，并附上可复核的原文位置；",
            "- 系统写入：0 项。本次只读取企业资料并生成引用清单。",
          ].join("\n"),
        },
      ],
    },
  ],

  // 治理条款：state != exists 的条目就是「演示到真实」的距离。
  // 面板 patch 与 detail 同源，产出方即工具本身，故不另行登记面板。
  sources: [
    {
      blockRef: "step2.tool.KnowledgeSearch",
      producer: "企业知识库检索工具",
      state: "needs-change",
      gap: "检索能力已有，但服务端不产出 presentation（server/src 对该字段零命中）；需在工具执行器统一包一层摘要 + 命中行 patch",
    },
    {
      blockRef: "step3.tool.Read",
      producer: "Read 工具执行器",
      state: "needs-change",
      gap: "命中章节号需由检索侧带出，Read 自身不知道条款结构；面板的条款行同理",
    },
    {
      blockRef: "step4.tool.DingtalkContact",
      producer: "钉钉通讯录（DWS）",
      state: "needs-change",
      gap: "DWS 可查通讯录，但职级字段依赖客户组织架构是否维护；且无 presentation 输出",
    },
    {
      blockRef: "step5.tool.Write",
      producer: "Write 工具执行器",
      state: "needs-change",
      gap: "写文件本身已有，但不产出 presentation；产物摘要与留痕 feed 需执行器补",
    },
    {
      blockRef: "step5.artifact.制度条款引用",
      producer: "Agent 生成 HTML 产物",
      state: "exists",
    },
  ],
};
