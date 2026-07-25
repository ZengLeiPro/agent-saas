/**
 * 组织 instructions.md 编辑器（组织管理 → 自定义规则）。
 *
 * 与 CompanyInfoEditor 的形态一致，区别在语义：
 *   - company.md      组织事实（业务、产品、团队、制度），注入靠前
 *   - instructions.md 组织行为规则（语气、格式偏好、岗位约定），注入靠后，
 *                     可覆盖平台默认表达风格；安全边界与平台硬约束不受影响
 * 上限 20k 远小于 company.md 的 200k——行为规则写长本身就是反模式，长内容
 * 应该进公司信息（事实）或技能（流程）。
 *
 * 数据：sharedDir/tenants/{tenantId}/instructions.md，注入为 {{TENANT_INSTRUCTIONS}}。
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
import { fetchTenantInstructions, updateTenantInstructions } from "@agent/shared";

// 与 server 端 MAX_TENANT_INSTRUCTIONS_CHARS 对齐
const MAX_LENGTH = 20000;

const PLACEHOLDER = `例如：

- 对外回复统一使用简洁书面语，可以适度使用 emoji
- 日期一律写成「2026年7月25日」格式，不要用 2026-07-25
- 涉及报价一律引导客户联系商务，不要自行给出金额`;

interface TenantInstructionsSectionProps {
  tenantId: string;
  tenantName?: string;
}

export function TenantInstructionsSection({ tenantId, tenantName }: TenantInstructionsSectionProps) {
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
    fetchTenantInstructions(tenantId)
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
      await updateTenantInstructions(tenantId, content);
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
        title="自定义规则"
        description={
          readOnly
            ? `查看${tenantName ? `「${tenantName}」` : "当前组织"}的自定义规则，用于统一本组织 AI 助理的表达方式。仅本组织 Admin 可编辑。`
            : `设置${tenantName ? `「${tenantName}」` : "当前组织"}的表达规则（语气、格式、岗位约定），新会话生效。这里写「怎么说话」，公司信息写「我们是谁」。安全边界不受影响。`
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
          placeholder={PLACEHOLDER}
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
