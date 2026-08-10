import { useMemo, useState } from "react";

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
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";

export interface GovernedMembership {
  userId: string;
  persona: "platform_admin" | "org_admin" | "member";
  isOwner: boolean;
  status: string;
  version: number;
}

interface PreviewReceipt {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  expectedVersion: number;
}

interface MembershipAction {
  label: string;
  change: { persona?: "member" | "org_admin"; isOwner?: boolean; status?: "active" | "disabled" };
}

function availableActions(target: GovernedMembership): MembershipAction[] {
  if (target.persona === "member") return [{ label: "设为组织管理员", change: { persona: "org_admin" } }];
  if (target.isOwner) return [{ label: "撤销 Owner", change: { isOwner: false } }];
  return [
    { label: "授予 Owner", change: { isOwner: true } },
    { label: "降为成员", change: { persona: "member" } },
  ];
}

export function MembershipIdentityActions({
  tenantId,
  actor,
  target,
  onChanged,
}: {
  tenantId: string;
  actor: GovernedMembership | undefined;
  target: GovernedMembership;
  onChanged: () => void;
}) {
  const actions = useMemo(() => availableActions(target), [target]);
  const [action, setAction] = useState<MembershipAction | null>(null);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PreviewReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mayManage = actor?.isOwner === true && actor.userId !== target.userId;

  if (!mayManage) return <span className="text-xs text-muted-foreground">只读</span>;

  const close = () => { if (!busy) { setAction(null); setReason(""); setPreview(null); setError(null); } };
  const requestPreview = async () => {
    if (!action || reason.trim().length < 3) return;
    setBusy(true); setError(null);
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
    if (!action || !preview) return;
    setBusy(true); setError(null);
    try {
      await governanceAccessApi.updateMembership(target.userId, {
        expectedVersion: target.version,
        ...action.change,
        reason: reason.trim(),
        previewId: preview.previewId,
        baselineDigest: preview.baselineDigest,
        expiresAt: preview.expiresAt,
      }, tenantId);
      setAction(null); setReason(""); setPreview(null);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "身份变更失败，请重新预览");
      setPreview(null);
    } finally { setBusy(false); }
  };

  return <>
    <div className="flex flex-wrap gap-1">{actions.map(item => <Button key={item.label} type="button" size="sm" variant="outline" onClick={() => { setAction(item); setPreview(null); setError(null); }}>{item.label}</Button>)}</div>
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{action?.label}</DialogTitle><DialogDescription>目标成员：{target.userId}。身份变更必须先生成与当前版本绑定的权威预览。</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <label className="grid gap-1 text-sm"><span>变更原因</span><Input value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); }} placeholder="至少 3 个字符" disabled={busy} /></label>
          {preview ? <div className="rounded-lg border bg-muted/30 p-3 text-xs"><div>基线：{preview.baselineDigest.slice(0, 12)}…</div><div className="mt-1">预览有效期至：{new Date(preview.expiresAt).toLocaleString()}</div></div> : null}
          {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</div> : null}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={close} disabled={busy}>取消</Button>{preview ? <Button type="button" onClick={() => { void commit(); }} disabled={busy}>{busy ? "正在提交" : "确认变更"}</Button> : <Button type="button" onClick={() => { void requestPreview(); }} disabled={busy || reason.trim().length < 3}>{busy ? "正在预览" : "生成影响预览"}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
