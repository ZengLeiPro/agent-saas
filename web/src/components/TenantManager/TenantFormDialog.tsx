import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Tenant, CreateTenantInput, UpdateTenantInput } from "./types";
import { TENANT_SLUG_PATTERN } from "./types";

export interface TenantFormData {
  id: string;
  name: string;
}

interface TenantFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 创建模式；有值 = 编辑模式（仅可改 name） */
  editingTenant: Tenant | null;
  onCreate: (input: CreateTenantInput) => Promise<void>;
  onUpdate: (id: string, input: UpdateTenantInput) => Promise<void>;
}

export function TenantFormDialog({
  open,
  onOpenChange,
  editingTenant,
  onCreate,
  onUpdate,
}: TenantFormDialogProps) {
  const isEdit = editingTenant !== null;
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setId(editingTenant?.id || "");
      setName(editingTenant?.name || "");
      setError("");
    }
  }, [open, editingTenant]);

  const handleSubmit = async () => {
    if (!isEdit) {
      const idTrim = id.trim();
      if (!idTrim) {
        setError("请输入 slug");
        return;
      }
      if (!TENANT_SLUG_PATTERN.test(idTrim)) {
        setError("slug 必须以小写字母开头，可含小写字母/数字/连字符，长度 2-31");
        return;
      }
    }
    if (!name.trim()) {
      setError("请输入名称");
      return;
    }
    setError("");
    setLoading(true);
    try {
      if (isEdit && editingTenant) {
        if (name.trim() !== editingTenant.name) {
          await onUpdate(editingTenant.id, { name: name.trim() });
        }
      } else {
        await onCreate({ id: id.trim(), name: name.trim() });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑组织" : "新建组织"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tenant-id">
              Slug（建后不可改）
            </Label>
            <Input
              id="tenant-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="例如：acme-corp"
              disabled={isEdit || loading}
              autoFocus={!isEdit}
            />
            <p className="text-xs text-muted-foreground">
              小写字母开头，可含小写字母/数字/连字符，长度 2-31。slug 即 path/审计 key，
              建后不可改。
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant-name">名称</Label>
            <Input
              id="tenant-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：唯恩电气"
              disabled={loading}
              autoFocus={isEdit}
            />
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                保存中...
              </>
            ) : (
              "保存"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
