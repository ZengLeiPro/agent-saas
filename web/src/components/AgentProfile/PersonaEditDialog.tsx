import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchPersona, parsePersona, updatePersona } from "@agent/shared";

interface PersonaEditDialogProps {
  username: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PersonaEditDialog({ username, open, onOpenChange }: PersonaEditDialogProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPersona(username)
      .then((persona) => {
        if (!cancelled) setContent(parsePersona(persona || "").body);
      })
      .catch((cause) => {
        if (!cancelled) {
          setContent("");
          setError(cause instanceof Error ? cause.message : "读取人格定义失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, username]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await updatePersona(username, content);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存人格定义失败");
    } finally {
      setSaving(false);
    }
  }, [content, onOpenChange, username]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(80vh,44rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>编辑人格定义</DialogTitle>
          <DialogDescription>定义 Agent 的人格和行为风格，新会话生效。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Textarea
              aria-label="人格定义内容"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="定义你的 Agent 的性格、说话风格和专业知识..."
              maxLength={10000}
              className="min-h-0 flex-1 resize-none font-mono text-sm"
              autoFocus
            />
          )}
          {error ? <p className="mt-2 text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter className="border-t px-6 py-4 sm:justify-between">
          <span className="text-xs text-muted-foreground">{content.length}/10000</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button onClick={() => { void handleSave(); }} disabled={loading || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
