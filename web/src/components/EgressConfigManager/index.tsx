import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, Save, Radar } from "lucide-react";
import {
  fetchEgressConfig,
  probeEgressProxy,
  updateEgressConfig,
  type EgressConfig,
  type EgressConfigAdminView,
  type EgressProbeResponse,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useAuth } from "@/contexts/AuthContext";

const EMPTY_CONFIG: EgressConfig = {
  server: {
    enabled: false,
    proxyUrl: "",
    matchDomains: [],
    bypassDomains: [],
    timeoutMs: 20_000,
    failOpen: true,
  },
  sandbox: { enabled: false, proxyUrl: "", noProxy: [] },
  packageMirrors: {
    enabled: false,
    pipIndexUrl: "https://mirrors.aliyun.com/pypi/simple/",
    pipTrustedHost: "mirrors.aliyun.com",
    npmRegistry: "https://registry.npmmirror.com",
  },
};

/** 多行文本 ↔ 字符串数组：每行一条，忽略空行与首尾空白 */
function linesToList(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function listToLines(value: string[]): string {
  return value.join("\n");
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

function ProbeRow({ label, result }: { label: string; result: EgressProbeResponse["direct"] }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={result.ok ? "text-success-ink" : "text-danger-ink"}>
        {result.ok
          ? `可达（HTTP ${result.status}，${result.latencyMs}ms）`
          : `不可达：${result.error ?? `HTTP ${result.status}`}`}
      </span>
    </div>
  );
}

export function EgressConfigManager() {
  const { platformReadOnly } = useAuth();
  const [view, setView] = useState<EgressConfigAdminView | null>(null);
  const [draft, setDraft] = useState<EgressConfig>(EMPTY_CONFIG);
  const [credential, setCredential] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<EgressProbeResponse | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const patchServer = useCallback((patch: Partial<EgressConfig["server"]>) => {
    setDraft((current) => ({ ...current, server: { ...current.server, ...patch } }));
    setDirty(true);
    setMessage(null);
  }, []);

  const patchSandbox = useCallback((patch: Partial<EgressConfig["sandbox"]>) => {
    setDraft((current) => ({ ...current, sandbox: { ...current.sandbox, ...patch } }));
    setDirty(true);
    setMessage(null);
  }, []);

  const patchMirrors = useCallback((patch: Partial<EgressConfig["packageMirrors"]>) => {
    setDraft((current) => ({ ...current, packageMirrors: { ...current.packageMirrors, ...patch } }));
    setDirty(true);
    setMessage(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchEgressConfig();
      setView(next);
      setDraft(next.config);
      setCredential("");
      setClearCredential(false);
      setDirty(false);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const next = await updateEgressConfig({
        config: draft,
        ...(clearCredential
          ? { proxyCredential: null }
          : credential.trim()
            ? { proxyCredential: credential.trim() }
            : {}),
      });
      setView(next);
      setDraft(next.config);
      setCredential("");
      setClearCredential(false);
      setDirty(false);
      setMessage(
        next.sandboxSync.ok
          ? "配置已保存并应用"
          : `配置已保存，但下发容器编排失败：${next.sandboxSync.error ?? "未知原因"}（server 段不受影响）`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, credential, clearCredential]);

  const runProbe = useCallback(async (proxyUrl: string) => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await probeEgressProxy({ proxyUrl }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  }, []);

  const busy = loading || saving;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="网络出口"
        description="配置平台与容器访问外部网络的路径。分流规则由代理服务端的规则引擎负责，这里只决定「哪些流量交给代理」。"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
              <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
              刷新
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={platformReadOnly || busy || !dirty}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存配置
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto pb-2">
        {message && (
          <div className={message.includes("已保存并应用")
            ? "rounded-md border border-success/30 bg-success-subtle px-3 py-2 text-sm text-success-ink"
            : message.includes("已保存")
              ? "rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning-ink"
              : "rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger-ink"}
          >
            {message}
          </div>
        )}

        {/* 段一：平台自身出站 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>平台出站（WebFetch / WebSearch）</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  只影响这两个工具的网络请求。模型调用、对象存储、钉钉、短信等出站一律直连，不受此处影响。
                </p>
              </div>
              <Switch
                checked={draft.server.enabled}
                onCheckedChange={(enabled) => patchServer({ enabled })}
                disabled={platformReadOnly || loading}
                aria-label="平台出站代理开关"
              />
            </div>
          </CardHeader>
          <CardContent className="grid gap-5">
            <Field
              label="代理地址"
              description="仅支持 http / https（socks 请用下方容器出站段）。例：http://172.16.177.77:7890"
            >
              <div className="flex gap-2">
                <Input
                  aria-label="平台代理地址"
                  value={draft.server.proxyUrl}
                  placeholder="http://172.16.177.77:7890"
                  onChange={(event) => patchServer({ proxyUrl: event.target.value })}
                  disabled={platformReadOnly || loading}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void runProbe(draft.server.proxyUrl)}
                  disabled={busy || probing || !draft.server.proxyUrl.trim()}
                >
                  {probing ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
                  测试
                </Button>
              </div>
            </Field>

            {probe && (
              <div className="space-y-2">
                <ProbeRow label="经代理" result={probe.viaProxy} />
                <ProbeRow label="直连对照" result={probe.direct} />
                <p className="text-xs text-muted-foreground">
                  经代理可达而直连不可达，说明代理确实改变了可达性；两者都可达说明目标本身就能直连。
                </p>
              </div>
            )}

            <Field
              label="走代理的域名"
              description="每行一个域名后缀，example.com 会命中 a.example.com。留空表示全部走代理——不建议，会把境内流量也绕出去。"
            >
              <Textarea
                aria-label="走代理的域名"
                rows={4}
                value={listToLines(draft.server.matchDomains)}
                placeholder={"openai.com\ngithub.com\ngoogle.com"}
                onChange={(event) => patchServer({ matchDomains: linesToList(event.target.value) })}
                disabled={platformReadOnly || loading}
              />
            </Field>

            <Field
              label="强制直连的域名"
              description="优先级高于上一项。已知境内可达的域名放这里能减少代理负载。"
            >
              <Textarea
                aria-label="强制直连的域名"
                rows={3}
                value={listToLines(draft.server.bypassDomains)}
                onChange={(event) => patchServer({ bypassDomains: linesToList(event.target.value) })}
                disabled={platformReadOnly || loading}
              />
            </Field>

            <div className="grid gap-5 md:grid-cols-2">
              <Field label="超时（毫秒）" description="经代理的单次请求超时，1000–300000。">
                <Input
                  aria-label="代理超时"
                  type="number"
                  min={1000}
                  max={300000}
                  value={draft.server.timeoutMs}
                  onChange={(event) => patchServer({ timeoutMs: Number(event.target.value) })}
                  disabled={platformReadOnly || loading}
                />
              </Field>
              <Field
                label="代理不可用时降级直连"
                description="建议开启。多数站点直连本来就可达，关闭后代理一挂会让抓取整体失败。"
              >
                <div className="flex h-9 items-center">
                  <Switch
                    checked={draft.server.failOpen}
                    onCheckedChange={(failOpen) => patchServer({ failOpen })}
                    disabled={platformReadOnly || loading}
                    aria-label="降级直连开关"
                  />
                </div>
              </Field>
            </div>

            <Field
              label="代理认证凭据"
              description={
                view?.proxyCredentialConfigured
                  ? "已配置。留空保留现有凭据；填写则替换。格式 user:password"
                  : "可选。多数内网代理无需认证。格式 user:password"
              }
            >
              <div className="space-y-2">
                <Input
                  aria-label="代理认证凭据"
                  type="password"
                  autoComplete="new-password"
                  value={credential}
                  placeholder={view?.proxyCredentialConfigured ? "留空保留现有凭据" : "user:password"}
                  onChange={(event) => {
                    setCredential(event.target.value);
                    setDirty(true);
                  }}
                  disabled={platformReadOnly || loading || clearCredential}
                />
                {view?.proxyCredentialConfigured && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch
                      checked={clearCredential}
                      onCheckedChange={(checked) => {
                        setClearCredential(checked);
                        setDirty(true);
                      }}
                      disabled={platformReadOnly || loading}
                      aria-label="清除代理凭据"
                    />
                    清除已保存的凭据
                  </label>
                )}
              </div>
            </Field>
          </CardContent>
        </Card>

        {/* 段二：容器出站 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>容器出站（Shell / 浏览器 / 钉钉飞书 CLI）</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  以环境变量注入容器，大小写各一份。代理地址若是内网 IP，会自动加入容器网络放行规则。
                </p>
              </div>
              <div className="flex items-center gap-2">
                {view?.sandboxSync.syncedAt && (
                  <Badge variant="outline">
                    {view.sandboxSync.ok ? "已下发" : "下发失败"}
                  </Badge>
                )}
                <Switch
                  checked={draft.sandbox.enabled}
                  onCheckedChange={(enabled) => patchSandbox({ enabled })}
                  disabled={platformReadOnly || loading}
                  aria-label="容器出站代理开关"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs leading-5 text-warning-ink">
              环境变量在容器创建时固化，因此这里的改动<strong>只对新建容器生效</strong>。
              已在运行的容器需等待其空闲暂停后重建，或在「执行环境池」里手动删除对应容器。
            </div>
            <Field
              label="代理地址"
              description="支持 http / https / socks5。例：http://172.16.177.77:7890"
            >
              <Input
                aria-label="容器代理地址"
                value={draft.sandbox.proxyUrl}
                placeholder="http://172.16.177.77:7890"
                onChange={(event) => patchSandbox({ proxyUrl: event.target.value })}
                disabled={platformReadOnly || loading}
              />
            </Field>
            <Field
              label="额外绕过代理的地址"
              description="每行一条。本机地址、VPC DNS、内网段、.aliyuncs.com 与集群域名已强制绕过，无需重复填写。"
            >
              <Textarea
                aria-label="容器绕过代理地址"
                rows={3}
                value={listToLines(draft.sandbox.noProxy)}
                onChange={(event) => patchSandbox({ noProxy: linesToList(event.target.value) })}
                disabled={platformReadOnly || loading}
              />
            </Field>
          </CardContent>
        </Card>

        {/* 段三：镜像源 */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>软件包镜像源</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  与代理无关的独立加速手段。容器内安装 Python / Node 依赖走国内镜像，通常比走代理更快也更稳。
                </p>
              </div>
              <Switch
                checked={draft.packageMirrors.enabled}
                onCheckedChange={(enabled) => patchMirrors({ enabled })}
                disabled={platformReadOnly || loading}
                aria-label="镜像源开关"
              />
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <Field label="pip 索引地址" description="容器内 PIP_INDEX_URL。">
              <Input
                aria-label="pip 索引地址"
                value={draft.packageMirrors.pipIndexUrl}
                onChange={(event) => patchMirrors({ pipIndexUrl: event.target.value })}
                disabled={platformReadOnly || loading}
              />
            </Field>
            <Field label="pip 信任主机" description="容器内 PIP_TRUSTED_HOST，通常填索引地址的主机名。">
              <Input
                aria-label="pip 信任主机"
                value={draft.packageMirrors.pipTrustedHost}
                onChange={(event) => patchMirrors({ pipTrustedHost: event.target.value })}
                disabled={platformReadOnly || loading}
              />
            </Field>
            <Field label="npm 源" description="容器内 NPM_CONFIG_REGISTRY。">
              <Input
                aria-label="npm 源"
                value={draft.packageMirrors.npmRegistry}
                onChange={(event) => patchMirrors({ npmRegistry: event.target.value })}
                disabled={platformReadOnly || loading}
              />
            </Field>
          </CardContent>
        </Card>

        {view?.updatedAt && (
          <p className="px-1 pb-2 text-xs text-muted-foreground">
            最近更新：{new Date(view.updatedAt).toLocaleString("zh-CN")}
            {view.updatedBy ? ` · ${view.updatedBy}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

export default EgressConfigManager;
