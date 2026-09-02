import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSettingsDirtyEntry } from "@/components/PersonalSettings/dirtyRegistry";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

export interface GovernedMembership {
  userId: string;
  persona: "platform_admin" | "org_admin" | "member";
  isOwner: boolean;
  status: string;
  version: number;
  directoryProfile?: { username: string; displayName: string } | null;
  allowedActions: MembershipAction[];
}

interface PreviewReceipt {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  expectedVersion: number;
  impact: {
    from: { persona: string; isOwner: boolean; status: string };
    to: { persona: string; isOwner: boolean; status: string };
    blockers: string[]; reversible: boolean; effectiveMode: string;
  };
}

interface MembershipReceipt {
  userId: string; version: number; changeId: string; auditId: string; effectiveAt: string;
  projectionStatus: string; projectionId?: string; auditCompletion?: "pending"; auditProjectionId?: string;
}

interface MembershipAction {
  id: string;
  label: string;
  change: { persona?: "member" | "org_admin"; isOwner?: boolean; status?: "active" | "disabled" };
  requiresReason: boolean;
}

export function MembershipIdentityActions({
  tenantId,
  target,
  onChanged,
}: {
  tenantId: string;
  target: GovernedMembership;
  onChanged: () => void;
}) {
  const actions = target.allowedActions;
  const [action, setAction] = useState<MembershipAction | null>(null);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PreviewReceipt | null>(null);
  const [receipt, setReceipt] = useState<MembershipReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => { if (!busy) { setAction(null); setReason(""); setPreview(null); setReceipt(null); setError(null); } };
  const requestPreview = async () => {
    if (!action || reason.trim().length < 3) return;
    setBusy(true); setError(null); setReceipt(null);
    try {
      setPreview(await governanceAccessApi.previewMembership<PreviewReceipt>(target.userId, {
        expectedVersion: target.version,
        ...action.change,
        reason: reason.trim(),
      }, tenantId));
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "无法取得权威预览");
    } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!action || !preview) return false;
    setBusy(true); setError(null);
    try {
      const result = await governanceAccessApi.updateMembership<MembershipReceipt>(target.userId, {
        expectedVersion: target.version,
        ...action.change,
        reason: reason.trim(),
        previewId: preview.previewId,
        baselineDigest: preview.baselineDigest,
        expiresAt: preview.expiresAt,
      }, tenantId);
      setReceipt(result);
      setPreview(null);
      onChanged();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "身份变更失败，请重新预览");
      setPreview(null);
      return false;
    } finally { setBusy(false); }
  };

  useSettingsDirtyEntry({
    id: `organization-membership:${tenantId}:${target.userId}`,
    label: `${target.directoryProfile?.displayName ?? target.userId} 身份变更`,
    dirty: Boolean(action && !receipt && (reason || preview)),
    save: async () => { if (!preview) { setError("请先生成权威预览，再保存并离开。"); throw new Error("Membership preview required"); } if (!await commit()) throw new Error("Membership commit failed"); },
    discard: close,
    draft: { actionId: action?.id, reason },
  });

  if (!actions.length) return <span className="text-xs text-muted-foreground">只读</span>;

  return <>
    <div className="flex flex-wrap gap-1">{actions.map(item => <Button key={item.id} type="button" size="sm" variant="outline" onClick={() => { setAction(item); setPreview(null); setReceipt(null); setError(null); }}>{item.label}</Button>)}</div>
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{action?.label}</DialogTitle><DialogDescription>目标成员：{target.directoryProfile?.displayName ?? target.userId}{target.directoryProfile?.username ? `（${target.directoryProfile.username}）` : ""}；稳定 ID：{target.userId}。身份变更必须先生成与当前版本绑定的权威预览。</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <label className="grid gap-1 text-sm"><span>变更原因</span><Input value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); }} placeholder="至少 3 个字符" disabled={busy} /></label>
          {preview ? <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs"><div className="font-medium">权威影响</div><div>{preview.impact.from.persona}/{preview.impact.from.status}{preview.impact.from.isOwner ? "/Owner" : ""} → {preview.impact.to.persona}/{preview.impact.to.status}{preview.impact.to.isOwner ? "/Owner" : ""}</div><div>生效方式：{preview.impact.effectiveMode} · {preview.impact.reversible ? "可逆" : "不可逆"}</div>{preview.impact.blockers.length ? <div className="rounded border border-destructive/30 p-2 text-destructive">阻断：{preview.impact.blockers.join("、")}</div> : <div>阻断项：无</div>}<div>基线：{preview.baselineDigest.slice(0, 12)}… · 有效期至 {new Date(preview.expiresAt).toLocaleString()}</div></div> : null}
          {receipt ? <div className="space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs"><div className="font-medium">变更回执</div><div>changeId：{receipt.changeId}</div><div>auditId：{receipt.auditId}{receipt.auditCompletion === "pending" ? "（终态审计排队中）" : ""}</div><div>生效时间：{new Date(receipt.effectiveAt).toLocaleString()} · Membership v{receipt.version}</div><div>投影：{receipt.projectionStatus}{receipt.projectionId ? ` · ${receipt.projectionId}` : ""}</div></div> : null}
          {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
        </div>
        <DialogFooter>{receipt ? <Button type="button" onClick={close}>完成</Button> : <><Button type="button" variant="outline" onClick={close} disabled={busy}>取消</Button>{preview ? <Button type="button" onClick={() => { void commit(); }} disabled={busy || preview.impact.blockers.length > 0 || Date.parse(preview.expiresAt) <= Date.now()}>{busy ? "正在提交" : "确认变更"}</Button> : <Button type="button" onClick={() => { void requestPreview(); }} disabled={busy || reason.trim().length < 3}>{busy ? "正在预览" : "生成影响预览"}</Button>}</>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
