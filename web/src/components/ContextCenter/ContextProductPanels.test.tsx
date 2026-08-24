import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ContextEntitiesPanel, ContextReviewsPanel, ContextTimelinePanel } from "./ContextProductPanels";
import type { ContextCenterApiPort, ContextEntityDetail, ContextEntityProfile } from "./types";

const authority = { scope: "organization" as const, label: "组织上下文" };
const evidence = [{ id: "ce1.payload.signature", type: "document", label: "交付纪要", summary: "客户确认负责人", occurredAt: "2026-08-23T02:00:00.000Z" }];
const secondEvidence = [{ id: "ce1.second.signature", type: "document", label: "排期纪要", summary: "客户确认排期", occurredAt: "2026-08-23T02:30:00.000Z" }];
const entityEvidence = [{ id: "ce1.entity.signature", type: "document", label: "实体总览", summary: "项目总览", occurredAt: "2026-08-23T01:00:00.000Z" }];
const entity = {
  id: "entity-1", type: "Project", label: "项目甲", summary: "交付项目", revision: 7,
  updatedAt: "2026-08-23T03:00:00.000Z", degraded: false,
};
const item = {
  ...entity, id: "item-1", type: "Status" as const, label: "负责人", summary: "王五",
  authority, evidence, review: "confirmed" as const, correctable: true, correctionDisabledReason: null,
};
const secondItem = {
  ...entity, id: "item-2", type: "Task" as const, label: "交付排期", summary: "下周",
  authority, evidence: secondEvidence, review: "confirmed" as const, correctable: true, correctionDisabledReason: null,
};
const profileAttribute = {
  ...entity, id: "facet-1", type: "role" as const, label: "负责人", summary: "王五",
  authority, evidence, conflict: null, review: "confirmed" as const,
};
const detail: ContextEntityDetail = {
  ...entity,
  correctionRevisions: { personal: 3, organization: 11 },
  evidence: entityEvidence,
  items: [item, secondItem],
  corrections: [],
};
const profile: ContextEntityProfile = {
  entityId: entity.id, label: entity.label, summary: entity.summary, revision: 7,
  updatedAt: entity.updatedAt, degraded: false, attributes: [profileAttribute],
};
const emptyPage = { items: [], nextCursor: null, degraded: false };

function api(overrides: Partial<ContextCenterApiPort> = {}): ContextCenterApiPort {
  return {
    getSnapshot: vi.fn(), getEvidence: vi.fn().mockResolvedValue([]),
    listTimeline: vi.fn().mockResolvedValue(emptyPage),
    listEntities: vi.fn().mockResolvedValue(emptyPage),
    getEntity: vi.fn(), listEntityItems: vi.fn().mockResolvedValue({ items: detail.items, nextCursor: null, degraded: false }),
    listEntityCorrections: vi.fn().mockResolvedValue({ items: detail.corrections, nextCursor: null, degraded: false }), getEntityProfile: vi.fn(),
    listEntityRelations: vi.fn().mockResolvedValue(emptyPage),
    listReviews: vi.fn().mockResolvedValue(emptyPage),
    createCorrection: vi.fn(), decideReview: vi.fn(),
    ...overrides,
  };
}

describe("Context 产品面板", () => {
  it("顶层 Timeline 消费 nextCursor、追加去重，筛选后重置第一页且保留降级上限提示", async () => {
    const user = userEvent.setup();
    const first = { ...entity, id: "timeline-page-1", type: "Status", label: "Timeline 第一页", occurredAt: entity.updatedAt, entityId: entity.id, entityLabel: entity.label, authority, evidence };
    const second = { ...first, id: "timeline-page-2", label: "Timeline 第二页" };
    const filtered = { ...first, id: "timeline-filtered", label: "筛选后第一页", degraded: true };
    const listTimeline = vi.fn().mockImplementation((query: { cursor?: string; filter?: string }) => {
      if (query.filter === "负责人") return Promise.resolve({ items: [filtered], nextCursor: null, degraded: true });
      if (query.cursor === "timeline-cursor") return Promise.resolve({ items: [first, second], nextCursor: null, degraded: false });
      return Promise.resolve({ items: [first], nextCursor: "timeline-cursor", degraded: false });
    });
    render(<ContextTimelinePanel api={api({ listTimeline })} />);
    expect(await screen.findByText("Timeline 第一页")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("Timeline 第二页")).toBeTruthy();
    expect(screen.getAllByText("Timeline 第一页")).toHaveLength(1);
    expect(listTimeline).toHaveBeenCalledWith(expect.objectContaining({ cursor: "timeline-cursor" }));
    await user.type(screen.getByLabelText("Timeline 筛选"), "负责人");
    await user.click(screen.getByRole("button", { name: "筛选" }));
    expect(await screen.findByText("筛选后第一页")).toBeTruthy();
    expect(screen.queryByText("Timeline 第二页")).toBeNull();
    expect(screen.getByText(/已达后端候选上限/)).toBeTruthy();
    expect(listTimeline).toHaveBeenLastCalledWith(expect.objectContaining({ filter: "负责人", cursor: undefined }));
  });

  it("实体列表消费 nextCursor、追加按 id 去重，筛选后重置第一页", async () => {
    const user = userEvent.setup();
    const secondEntity = { ...entity, id: "entity-2", label: "项目乙" };
    const filteredEntity = { ...entity, id: "entity-filtered", label: "筛选实体" };
    const listEntities = vi.fn().mockImplementation((query: { cursor?: string; filter?: string }) => {
      if (query.filter === "Person") return Promise.resolve({ items: [filteredEntity], nextCursor: null, degraded: false });
      if (query.cursor === "entity-cursor") return Promise.resolve({ items: [entity, secondEntity], nextCursor: null, degraded: false });
      return Promise.resolve({ items: [entity], nextCursor: "entity-cursor", degraded: false });
    });
    render(<ContextEntitiesPanel api={api({ listEntities })} />);
    expect(await screen.findByText("项目甲")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("项目乙")).toBeTruthy();
    expect(screen.getAllByText("项目甲")).toHaveLength(1);
    expect(listEntities).toHaveBeenCalledWith(expect.objectContaining({ cursor: "entity-cursor" }));
    await user.type(screen.getByLabelText("实体筛选"), "Person");
    await user.click(screen.getByRole("button", { name: "筛选" }));
    expect(await screen.findByText("筛选实体")).toBeTruthy();
    expect(screen.queryByText("项目乙")).toBeNull();
  });

  it("实体内 Timeline 消费 nextCursor 并追加按 id 去重", async () => {
    const user = userEvent.setup();
    const first = { ...entity, id: "entity-timeline-1", type: "Status", label: "实体 Timeline 一", occurredAt: entity.updatedAt, entityId: entity.id, entityLabel: entity.label, authority, evidence };
    const second = { ...first, id: "entity-timeline-2", label: "实体 Timeline 二" };
    const listTimeline = vi.fn().mockImplementation((query: { cursor?: string; entityId?: string }) => Promise.resolve(query.cursor === "entity-timeline-cursor"
      ? { items: [first, second], nextCursor: null, degraded: false }
      : { items: [first], nextCursor: "entity-timeline-cursor", degraded: false }));
    render(<ContextEntitiesPanel api={api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity: vi.fn().mockResolvedValue(detail), getEntityProfile: vi.fn().mockResolvedValue(profile), listTimeline,
    })} />);
    await user.click(await screen.findByRole("button", { name: /项目甲/ }));
    await user.click(await screen.findByRole("tab", { name: "Timeline" }));
    expect(await screen.findByText("实体 Timeline 一")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("实体 Timeline 二")).toBeTruthy();
    expect(screen.getAllByText("实体 Timeline 一")).toHaveLength(1);
    expect(listTimeline).toHaveBeenCalledWith({ entityId: "entity-1", cursor: "entity-timeline-cursor" });
  });

  it("实体关系消费 nextCursor、追加去重，depth 变化重置第一页并保留二跳路径语义", async () => {
    const user = userEvent.setup();
    const oneHop = {
      ...entity, id: "relation-page-1", type: "task_of", label: "一跳关系一", depth: 1 as const,
      level: "explicit" as const, reviewStatus: "confirmed" as const,
      fromEntity: { id: entity.id, type: entity.type, label: entity.label, summary: entity.summary },
      targetEntity: { id: "person-1", type: "Person", label: "王五", summary: null }, authority, evidence,
    };
    const oneHopSecond = { ...oneHop, id: "relation-page-2", label: "一跳关系二", targetEntity: { ...oneHop.targetEntity, id: "person-2", label: "李四" } };
    const twoHop = { ...oneHop, id: "relation-depth-2", label: "二跳路径", depth: 2 as const, fromEntity: oneHop.targetEntity, targetEntity: { id: "task-1", type: "Task", label: "上线验收", summary: null } };
    const listEntityRelations = vi.fn().mockImplementation((_id: string, query: { cursor?: string; depth?: 1 | 2 }) => {
      if (query.depth === 2) return Promise.resolve({ items: [twoHop], nextCursor: null, degraded: false });
      if (query.cursor === "relation-cursor") return Promise.resolve({ items: [oneHop, oneHopSecond], nextCursor: null, degraded: false });
      return Promise.resolve({ items: [oneHop], nextCursor: "relation-cursor", degraded: false });
    });
    render(<ContextEntitiesPanel api={api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity: vi.fn().mockResolvedValue(detail), getEntityProfile: vi.fn().mockResolvedValue(profile), listEntityRelations,
    })} />);
    await user.click(await screen.findByRole("button", { name: /项目甲/ }));
    await user.click(await screen.findByRole("tab", { name: "关系" }));
    expect(await screen.findByText("一跳关系一")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("一跳关系二")).toBeTruthy();
    expect(screen.getAllByText("一跳关系一")).toHaveLength(1);
    expect(listEntityRelations).toHaveBeenCalledWith("entity-1", { depth: 1, cursor: "relation-cursor" });
    await user.selectOptions(screen.getByLabelText("关系深度"), "2");
    expect(await screen.findByText("二跳路径")).toBeTruthy();
    expect(screen.queryByText("一跳关系二")).toBeNull();
    expect(screen.getByRole("list", { name: "中心实体邻接关系" }).textContent).toMatch(/上一跳\s*王五\s*→\s*上线验收/);
    expect(listEntityRelations).toHaveBeenLastCalledWith("entity-1", { depth: 2 });
  });

  it("审核列表分页追加去重，操作成功后仅重载第一页而不拼回旧 cursor 队列", async () => {
    const user = userEvent.setup();
    const first = { ...entity, id: "review-page-1", type: "Status", label: "审核一", status: "proposed" as const, entityId: entity.id, entityLabel: entity.label, originalSummary: null, proposedSummary: "值一", conflict: null, authority, evidence };
    const second = { ...first, id: "review-page-2", label: "审核二", proposedSummary: "值二" };
    const reloaded = { ...first, id: "review-reloaded", label: "重载第一页", proposedSummary: "新值" };
    let firstPageCalls = 0;
    const listReviews = vi.fn().mockImplementation((query: { cursor?: string }) => {
      if (query.cursor === "review-cursor") return Promise.resolve({ items: [first, second], nextCursor: null, degraded: false });
      firstPageCalls += 1;
      return Promise.resolve(firstPageCalls === 1
        ? { items: [first], nextCursor: "review-cursor", degraded: false }
        : { items: [reloaded], nextCursor: null, degraded: false });
    });
    const decideReview = vi.fn().mockResolvedValue({ status: "confirmed" });
    render(<ContextReviewsPanel api={api({ listReviews, decideReview })} />);
    expect(await screen.findByText("值一")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("值二")).toBeTruthy();
    expect(screen.getAllByText("值一")).toHaveLength(1);
    expect(listReviews).toHaveBeenCalledWith(expect.objectContaining({ cursor: "review-cursor" }));
    await user.click(screen.getAllByRole("button", { name: "确认建议值" })[0]);
    expect(await screen.findByText("新值")).toBeTruthy();
    expect(screen.queryByText("值二")).toBeNull();
    expect(listReviews).toHaveBeenLastCalledWith({ filter: undefined });
  });

  it("点击 Evidence 通过 signed handle 拉取授权详情，展示 quote/source/freshness/originalUrl 且不打印 handle", async () => {
    const timelineItem = { ...entity, id: "timeline-1", type: "Status", label: "负责人变更", occurredAt: "2026-08-23T02:00:00.000Z", entityId: entity.id, entityLabel: entity.label, authority, evidence, degraded: true };
    let resolveEvidence: ((value: Awaited<ReturnType<ContextCenterApiPort["getEvidence"]>>) => void) | undefined;
    const getEvidence = vi.fn().mockImplementation(() => new Promise(resolve => { resolveEvidence = resolve; }));
    render(<ContextTimelinePanel api={api({ getEvidence, listTimeline: vi.fn().mockResolvedValue({ items: [timelineItem], nextCursor: null, degraded: true }) })} />);
    expect(await screen.findByText("负责人变更")).toBeTruthy();
    expect(screen.getByText(/当前结果为降级数据/)).toBeTruthy();
    expect(document.body.textContent).toContain("2026/08/23 10:00");
    fireEvent.click(screen.getByRole("button", { name: /Evidence.*1 条/ }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("status")).toBeTruthy();
    await act(async () => resolveEvidence?.([{
      id: "authorized-evidence", sourceName: "钉钉", collection: "项目群", author: "张三",
      occurredAt: "2026-08-23T02:00:00.000Z", quote: "客户确认负责人为王五", derived: false,
      freshness: "fresh", freshnessAsOf: "2026-08-23T03:00:00.000Z", originalUrl: "https://example.com/original",
    }]));
    expect(await within(drawer).findByText("客户确认负责人为王五")).toBeTruthy();
    expect(within(drawer).getByText(/钉钉 · 项目群 · 张三/)).toBeTruthy();
    expect(within(drawer).getByText(/fresh/)).toBeTruthy();
    expect(within(drawer).getByRole("link", { name: "https://example.com/original" })).toBeTruthy();
    expect(getEvidence).toHaveBeenCalledWith("ce1.payload.signature", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(within(drawer).queryByText(/ce1\.payload\.signature/)).toBeNull();
  });

  it("Evidence 授权详情失败时支持重试", async () => {
    const user = userEvent.setup();
    const timelineItem = { ...entity, id: "timeline-1", type: "Status", label: "负责人变更", occurredAt: "2026-08-23T02:00:00.000Z", entityId: entity.id, entityLabel: entity.label, authority, evidence };
    const getEvidence = vi.fn()
      .mockRejectedValueOnce(new Error("授权详情暂不可用"))
      .mockResolvedValueOnce([{
        id: "authorized-evidence", sourceName: "钉钉", collection: "项目群", author: null,
        occurredAt: "2026-08-23T02:00:00.000Z", quote: "重试成功", derived: false,
        freshness: "aging", freshnessAsOf: null, originalUrl: null,
      }]);
    render(<ContextTimelinePanel api={api({ getEvidence, listTimeline: vi.fn().mockResolvedValue({ items: [timelineItem], nextCursor: null, degraded: false }) })} />);
    await user.click(await screen.findByRole("button", { name: /Evidence.*1 条/ }));
    expect(await screen.findByText("Evidence 授权详情加载失败，请重试")).toBeTruthy();
    expect(screen.queryByText("授权详情暂不可用")).toBeNull();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("重试成功")).toBeTruthy();
    expect(getEvidence).toHaveBeenCalledTimes(2);
  });

  it("实体画像使用固定 profile facets；关系支持一/二跳、移动单列与桌面三列 list 语义", async () => {
    const user = userEvent.setup();
    const oneHop = {
      ...entity, id: "relation-1", type: "task_of", label: "task_of", depth: 1 as const,
      level: "explicit" as const, reviewStatus: "confirmed" as const,
      fromEntity: { id: entity.id, type: entity.type, label: entity.label, summary: entity.summary },
      targetEntity: { id: "person-1", type: "Person", label: "王五", summary: null }, authority, evidence,
    };
    const twoHop = {
      ...oneHop, id: "relation-2", depth: 2 as const,
      fromEntity: oneHop.targetEntity,
      targetEntity: { id: "task-1", type: "Task", label: "上线验收", summary: null },
    };
    const listEntityRelations = vi.fn().mockImplementation((_entityId: string, query: { depth?: 1 | 2 }) =>
      Promise.resolve({ items: query.depth === 2 ? [twoHop] : [oneHop], nextCursor: null, degraded: false }));
    const port = api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity: vi.fn().mockResolvedValue(detail), getEntityProfile: vi.fn().mockResolvedValue(profile),
      listEntityRelations,
    });
    render(<ContextEntitiesPanel api={port} />);
    fireEvent.click(await screen.findByRole("button", { name: /项目甲/ }));
    expect(await screen.findByRole("button", { name: "返回实体列表" })).toBeTruthy();
    for (const label of ["角色 Role", "任务 Tasks", "工作流 Workflow", "产物 Artifacts", "诀窍 Know-how"]) expect(screen.getByRole("region", { name: label })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "关系" }));
    expect(await screen.findByText("explicit · 明确")).toBeTruthy();
    expect(screen.getByText("confirmed · 已确认")).toBeTruthy();
    expect(screen.getByText("depth 1 · 一跳")).toBeTruthy();
    expect(screen.getByRole("list", { name: "中心实体邻接关系" }).textContent).toMatch(/中心\s*项目甲\s*→\s*王五/);
    expect(screen.getByText(/二跳展示上一跳到目标实体的有限授权路径，不是完整图谱/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("直连");
    const list = screen.getByRole("list", { name: "中心实体邻接关系" });
    expect(within(list).getByRole("listitem").className).toContain("grid-cols-1");
    expect(within(list).getByRole("listitem").className).toContain("md:grid-cols-3");
    expect(screen.queryByRole("table", { name: "中心实体邻接关系" })).toBeNull();
    expect(listEntityRelations).toHaveBeenCalledWith("entity-1", { depth: 1 });
    await user.selectOptions(screen.getByLabelText("关系深度"), "2");
    await waitFor(() => expect(listEntityRelations).toHaveBeenLastCalledWith("entity-1", { depth: 2 }));
    expect(await screen.findByText("depth 2 · 二跳")).toBeTruthy();
    expect(screen.getByRole("list", { name: "中心实体邻接关系" }).textContent).toMatch(/上一跳\s*王五\s*→\s*上线验收/);
  });

  it("reject 仅允许目标 Evidence，切目标重置默认值，scope 切换立即采用对应纠正基线", async () => {
    const user = userEvent.setup();
    const createCorrection = vi.fn().mockResolvedValue({ ...entity, id: "correction-1", type: "correction", label: "reject", summary: "王五", action: "reject", authority, evidence, revision: 8 });
    const getEntity = vi.fn().mockResolvedValue(detail);
    const getEntityProfile = vi.fn().mockResolvedValue(profile);
    const port = api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity, getEntityProfile, createCorrection,
    });
    render(<ContextEntitiesPanel api={port} />);
    fireEvent.click(await screen.findByRole("button", { name: /项目甲/ }));
    await screen.findByRole("button", { name: "返回实体列表" });
    await user.click(screen.getByRole("tab", { name: "纠正记录" }));
    await user.selectOptions(screen.getByLabelText("纠正动作"), "reject");
    expect((screen.getByRole("button", { name: "拒绝该项当前值" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/纠正基线 v11/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("纠正目标"), "item-1");
    expect(screen.getByText("交付纪要")).toBeTruthy();
    expect(screen.queryByText("实体总览")).toBeNull();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    await user.selectOptions(screen.getByLabelText("纠正目标"), "item-2");
    expect(screen.getByText("排期纪要")).toBeTruthy();
    expect(screen.queryByText("交付纪要")).toBeNull();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    await user.selectOptions(screen.getByLabelText("纠正目标"), "item-1");
    await user.selectOptions(screen.getByLabelText("纠正范围"), "personal");
    expect(screen.getByText(/纠正基线 v3/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "拒绝该项当前值" }));
    await waitFor(() => expect(createCorrection).toHaveBeenCalledWith("entity-1", {
      action: "reject", scope: "personal", targetItemId: "item-1", evidenceIds: ["ce1.payload.signature"], expectedRevision: 3,
    }));
    await waitFor(() => {
      expect(getEntity).toHaveBeenCalledTimes(2);
      expect(getEntityProfile).toHaveBeenCalledTimes(2);
    });
  });

  it("实体画像项和纠正记录分别消费 cursor、追加去重并保留降级提示", async () => {
    const user = userEvent.setup();
    const correctionOne = { ...entity, id: "correction-1", type: "correction", label: "负责人纠正", summary: "王五", action: "reject" as const, authority, evidence, revision: 8 };
    const correctionTwo = { ...correctionOne, id: "correction-2", label: "排期纠正", summary: "下周" };
    const listEntityItems = vi.fn().mockImplementation((_id: string, query?: { cursor?: string }) => Promise.resolve(query?.cursor
      ? { items: [item, secondItem], nextCursor: null, degraded: true }
      : { items: [item], nextCursor: "item-cursor", degraded: false }));
    const listEntityCorrections = vi.fn().mockImplementation((_id: string, query?: { cursor?: string }) => Promise.resolve(query?.cursor
      ? { items: [correctionOne, correctionTwo], nextCursor: null, degraded: false }
      : { items: [correctionOne], nextCursor: "correction-cursor", degraded: false }));
    render(<ContextEntitiesPanel api={api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity: vi.fn().mockResolvedValue(detail), getEntityProfile: vi.fn().mockResolvedValue(profile),
      listEntityItems, listEntityCorrections,
    })} />);

    await user.click(await screen.findByRole("button", { name: /项目甲/ }));
    await user.click(await screen.findByRole("tab", { name: "纠正记录" }));
    expect(within(screen.getByLabelText("纠正目标")).queryByRole("option", { name: /交付排期/ })).toBeNull();
    expect(screen.getByText("负责人纠正")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多可纠正画像项" }));
    expect(within(screen.getByLabelText("纠正目标")).getByRole("option", { name: /交付排期/ })).toBeTruthy();
    expect(within(screen.getByLabelText("纠正目标")).getAllByRole("option", { name: /负责人/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "加载更多纠正记录" }));
    expect(await screen.findByText("排期纠正")).toBeTruthy();
    expect(screen.getAllByText("负责人纠正")).toHaveLength(1);
    expect(screen.getByText(/当前结果为降级数据/)).toBeTruthy();
    expect(listEntityItems).toHaveBeenCalledWith("entity-1", { cursor: "item-cursor" });
    expect(listEntityCorrections).toHaveBeenCalledWith("entity-1", { cursor: "correction-cursor" });
  });

  it("proposed/conflicted 纠正目标可见但禁选并说明原因", async () => {
    const user = userEvent.setup();
    const proposed = { ...item, id: "item-proposed", label: "待审核负责人", review: "proposed" as const,
      correctable: false, correctionDisabledReason: "pending_review" as const };
    const conflicted = { ...secondItem, id: "item-conflicted", label: "冲突排期", review: "conflicted" as const,
      correctable: false, correctionDisabledReason: "conflicted" as const };
    render(<ContextEntitiesPanel api={api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity: vi.fn().mockResolvedValue({ ...detail, items: [item, proposed, conflicted] }),
      listEntityItems: vi.fn().mockResolvedValue({ items: [item, proposed, conflicted], nextCursor: null, degraded: false }),
      getEntityProfile: vi.fn().mockResolvedValue(profile),
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: /项目甲/ }));
    await user.click(await screen.findByRole("tab", { name: "纠正记录" }));
    const select = screen.getByLabelText("纠正目标");
    const proposedOption = within(select).getByRole("option", { name: /待审核负责人.*建议值待审核，不可纠正/ }) as HTMLOptionElement;
    const conflictedOption = within(select).getByRole("option", { name: /冲突排期.*冲突待审核，不可纠正/ }) as HTMLOptionElement;
    expect(proposedOption.disabled).toBe(true);
    expect(conflictedOption.disabled).toBe(true);
    expect(screen.getByText(/仅已确认且当前有效的画像项可作为纠正目标/)).toBeTruthy();
  });

  it("assert 必填新值；409 提供刷新实体详情动作", async () => {
    const user = userEvent.setup();
    const getEntity = vi.fn().mockResolvedValue(detail);
    const getEntityProfile = vi.fn().mockResolvedValue(profile);
    const createCorrection = vi.fn().mockRejectedValue(new Error("内容版本已变化，请刷新实体详情后重试。"));
    const port = api({
      listEntities: vi.fn().mockResolvedValue({ items: [entity], nextCursor: null, degraded: false }),
      getEntity, getEntityProfile, createCorrection,
    });
    render(<ContextEntitiesPanel api={port} />);
    fireEvent.click(await screen.findByRole("button", { name: /项目甲/ }));
    await screen.findByRole("button", { name: "返回实体列表" });
    await user.click(screen.getByRole("tab", { name: "纠正记录" }));
    await user.selectOptions(screen.getByLabelText("纠正目标"), "item-1");
    expect((screen.getByRole("button", { name: "提交新值主张" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("主张的新值"), "李四");
    await user.click(screen.getByRole("button", { name: "提交新值主张" }));
    expect(await screen.findByText("内容版本已变化，请刷新实体详情后重试。")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "刷新实体详情" }));
    await waitFor(() => expect(getEntity).toHaveBeenCalledTimes(2));
  });

  it("待审核仅显示 proposed/conflicted，confirm 终态后重拉队列", async () => {
    const user = userEvent.setup();
    const review = { ...entity, id: "review-1", type: "Status", label: "负责人", status: "conflicted" as const, entityId: entity.id, entityLabel: entity.label, originalSummary: "李四", proposedSummary: "王五", conflict: "两个来源不一致", authority, evidence };
    const terminal = { ...review, id: "review-2", status: "confirmed" as const };
    const listReviews = vi.fn().mockResolvedValueOnce({ items: [review, terminal], nextCursor: null, degraded: false }).mockResolvedValueOnce(emptyPage);
    const decideReview = vi.fn().mockResolvedValue({ status: "confirmed" });
    render(<ContextReviewsPanel api={api({ listReviews, decideReview })} />);
    expect(await screen.findByText("李四")).toBeTruthy();
    expect(screen.getByText("王五")).toBeTruthy();
    expect(screen.queryByText("review-2")).toBeNull();
    await user.click(screen.getByRole("button", { name: "确认建议值" }));
    await waitFor(() => expect(decideReview).toHaveBeenCalledWith("review-1", { decision: "confirm", expectedRevision: 7 }));
    await waitFor(() => expect(listReviews).toHaveBeenCalledTimes(2));
    expect(decideReview).toHaveBeenCalledTimes(1);
  });

  it("reject 终态后同样重拉待审核队列", async () => {
    const user = userEvent.setup();
    const review = { ...entity, id: "review-reject", type: "Task", label: "交付日期", status: "proposed" as const, entityId: entity.id, entityLabel: entity.label, originalSummary: null, proposedSummary: "下周", conflict: null, authority, evidence };
    const listReviews = vi.fn().mockResolvedValueOnce({ items: [review], nextCursor: null, degraded: false }).mockResolvedValueOnce(emptyPage);
    const decideReview = vi.fn().mockResolvedValue({ status: "rejected" });
    render(<ContextReviewsPanel api={api({ listReviews, decideReview })} />);
    await user.click(await screen.findByRole("button", { name: "拒绝建议值" }));
    await waitFor(() => expect(decideReview).toHaveBeenCalledWith("review-reject", { decision: "reject", expectedRevision: 7 }));
    await waitFor(() => expect(listReviews).toHaveBeenCalledTimes(2));
  });
});
