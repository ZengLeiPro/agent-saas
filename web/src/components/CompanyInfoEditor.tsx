/**
 * 组织 company.md 编辑器（组织管理 → 公司信息）。
 *
 * UI 形态参照个人设置中心的「记忆」模块（AgentProfile/index.tsx::MemorySection +
 * AgentProfile/AgentDocEditor.tsx）：SettingsPanelHeader 顶上一行标题描述，
 * 中间满高度 textarea，保存/编辑按钮挂到 SettingsPanelHeader.actions。
 *
 * 数据：sharedDir/tenants/{tenantId}/company.md，注入到该组织 agent 的 system prompt 作为 {{COMPANY_INFO}}。
 * 权限：平台 admin 可编辑任意组织；组织 admin 可编辑自己组织；后端 403 兜底。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pencil, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownReadonly } from "@/components/MarkdownReadonly";

import { useAuth } from "@/contexts/AuthContext";
import { DEFAULT_TENANT_ID } from "@/components/TenantManager/types";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { fetchTenantCompanyInfo, updateTenantCompanyInfo } from "@agent/shared";

const MAX_LENGTH = 200000;

interface CompanyInfoSectionProps {
  tenantId: string;
  tenantName?: string;
}

export function CompanyInfoSection({ tenantId, tenantName }: CompanyInfoSectionProps) {
  const { user, isAdmin, isPlatformAdmin, canPlatform } = useAuth();
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [editing, setEditing] = useState(false);
  const initial = useRef("");

  const dirty = content !== initial.current;
  const canEdit = isAdmin && (
    (isPlatformAdmin && tenantId !== DEFAULT_TENANT_ID && canPlatform("customer_config.manage"))
    || (!isPlatformAdmin && user?.tenantId === tenantId)
  );
  const readOnly = !canEdit || !tenantId;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!tenantId) {
      setContent("");
      initial.current = "";
      setLoading(false);
      return;
    }
    fetchTenantCompanyInfo(tenantId)
      .then((data) => {
        if (cancelled) return;
        setContent(data);
        initial.current = data;
        setEditing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setContent("");
        initial.current = "";
        setEditing(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    setSaveOk(false);
    try {
      await updateTenantCompanyInfo(tenantId, content);
      initial.current = content;
      setSaveMsg("已保存");
      setSaveOk(true);
      setEditing(false);
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveOk(false);
      setSaveMsg(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  }, [content, tenantId]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="公司信息"
        description={
          readOnly
            ? `查看${tenantName ? `「${tenantName}」` : "当前组织"}的公司信息（company.md），将注入该组织 agent 的 system prompt。仅本组织 Admin 可编辑。`
            : `维护${tenantName ? `「${tenantName}」` : "当前组织"}的公司信息（company.md），将注入该组织 agent 的 system prompt 作为 {{COMPANY_INFO}}，新会话生效。`
        }
        actions={(
          <>
            {saveMsg && (
              <span className={cn("text-sm", saveOk ? "text-success" : "text-destructive")}>
                {saveMsg}
              </span>
            )}
            {editing ? (
              <Button onClick={handleSave} disabled={loading || saving || !dirty || readOnly}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                保存
              </Button>
            ) : (
              <Button onClick={() => setEditing(true)} disabled={loading || readOnly}>
                <Pencil className="size-4" />
                编辑
              </Button>
            )}
          </>
        )}
      />

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : editing ? (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="当前组织公司信息（Markdown）..."
          maxLength={MAX_LENGTH}
          readOnly={readOnly}
          className="min-h-0 flex-1 resize-none font-mono text-sm"
        />
      ) : (
        <MarkdownReadonly content={content} />
      )}
    </div>
  );
}
