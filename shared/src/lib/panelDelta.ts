import type { PanelPatch, PanelPulse } from "./systemPanel";

type PulseCandidate = {
  view: string;
  ids: string[];
  kind: PanelPulse["kind"];
};

function candidate(patch: PanelPatch): PulseCandidate | null {
  if (patch.op === "pulse") return null;
  let ids: string[];
  if ("ids" in patch) ids = patch.ids;
  else if ("id" in patch) ids = [patch.id];
  else if ("rowId" in patch) ids = [patch.rowId];
  else if ("row" in patch) ids = [patch.row.id];
  else if ("card" in patch) ids = [patch.card.id];
  else if ("item" in patch) ids = [patch.item.id];
  else if ("rows" in patch) ids = patch.rows.map((row) => row.id);
  else if ("items" in patch) ids = patch.items.map((item) => item.k);
  else return null;

  const kind = patch.op === "rowInsert" || patch.op === "cardInsert"
    || patch.op === "tableRowInsert" || patch.op === "feedAppend"
    ? "new"
    : patch.op === "rowsSet" || patch.op === "statsSet" ? "scan" : "hit";
  return { view: patch.view, ids, kind };
}

/**
 * 从一组真实 panel patch 推导当前步骤的可见变化。
 *
 * 显式 pulse 仍是最高优先级；未声明时使用结构化写操作的稳定对象 ID，避免正式
 * 回放剧本和真实工具必须手工维护第二份 delta 数据。若一组 patch 同时改多个视图，
 * 优先使用 fold 后当前视图里的变化，避免把 delta 指向用户看不到的后台审计 tab。
 */
export function derivePanelPulse(patches: PanelPatch[], preferredView?: string): PanelPulse | null {
  const explicit = patches.filter((patch): patch is PanelPulse => patch.op === "pulse").at(-1);
  if (explicit) return explicit;

  const candidates = patches.map(candidate).filter((item): item is PulseCandidate => item !== null);
  const preferred = preferredView ? candidates.filter((item) => item.view === preferredView) : [];
  const scoped = preferred.length ? preferred : candidates;
  const latest = scoped.at(-1);
  if (!latest) return null;

  const ids = [...new Set(scoped
    .filter((item) => item.view === latest.view)
    .flatMap((item) => item.ids))];
  return ids.length ? { op: "pulse", view: latest.view, ids, kind: latest.kind } : null;
}
