import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save } from "lucide-react";

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
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setLoadError(null);
    setSaveError(null);
    fetchPersona(username)
      .then((persona) => {
        if (cancelled) return;
        setContent(parsePersona(persona || "").body);
        setLoaded(true);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "读取人格定义失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey, username]);

  const handleSave = useCallback(async () => {
    if (!loaded) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updatePersona(username, content);
      onOpenChange(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "保存人格定义失败");
    } finally {
      setSaving(false);
    }
  }, [content, loaded, onOpenChange, username]);

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
          ) : loadError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" role="alert">
              <p className="text-sm text-destructive">{loadError}</p>
              <Button type="button" variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
                <RefreshCw className="size-4" />
                重新加载
              </Button>
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
          {saveError ? <p className="mt-2 text-sm text-destructive" role="alert">{saveError}</p> : null}
        </div>
        <DialogFooter className="border-t px-6 py-4 sm:justify-between">
          <span className="text-xs text-muted-foreground">{loaded ? `${content.length}/10000` : "尚未加载"}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button onClick={() => { void handleSave(); }} disabled={!loaded || loading || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
