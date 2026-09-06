/**
 * WP3 §6.2-2：外部系统写操作的二次确认卡片。
 *
 * 规范要求卡片必须给出：**系统名、参数摘要、「确认后立即生效、不可撤销」、键入确认字**，
 * 并在 10 分钟无人确认时取消并告知「操作已取消，未写入任何数据」。
 *
 * 卡片内容来自服务端 ws `permission_request.confirmation`（可选字段）。
 * 该字段缺失时（旧服务端、或消息投影层尚未透传）**按工具名兜底自行推导** ——
 * `app__<systemId>__<capabilityId>` 与入参 JSON 已经够拼出系统名、能力名与参数摘要，
 * 宁可少一点中文名，也不能让写操作退回到没有二次确认的两键卡片。
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WsToolConfirmationCard } from '@agent/shared';
import { DEFAULT_CONFIRM_WORD } from './appConfirmation';

interface AppConfirmationCardProps {
  card: WsToolConfirmationCard;
  status: 'pending' | 'allowed' | 'denied';
  disabled?: boolean;
  onAllow: () => void;
  onDeny: () => void;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function AppConfirmationCard({
  card,
  status,
  disabled = false,
  onAllow,
  onDeny,
}: AppConfirmationCardProps) {
  const confirmWord = card.confirmWord ?? DEFAULT_CONFIRM_WORD;
  const [typed, setTyped] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const expiresAtMs = card.expiresAtMs;
  useEffect(() => {
    if (status !== 'pending' || expiresAtMs === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, expiresAtMs]);

  const remainingMs = expiresAtMs === undefined ? null : expiresAtMs - now;
  const expired = remainingMs !== null && remainingMs <= 0;
  const canConfirm = useMemo(
    () => !disabled && !expired && typed.trim() === confirmWord,
    [disabled, expired, typed, confirmWord],
  );

  return (
    <div
      className="rounded-md border border-warning/40 bg-warning/5 p-3"
      data-testid="app-confirmation-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
        <span className="text-sm font-medium">
          即将在《{card.systemName ?? '外部系统'}》中执行「{card.capabilityName ?? '写操作'}」
        </span>
      </div>

      {card.params && card.params.length > 0 ? (
        <dl className="mb-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
          {card.params.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="break-all">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mb-2 text-sm text-muted-foreground">本次操作没有需要确认的参数。</p>
      )}

      {card.irreversible !== false && (
        <p className="mb-2 text-sm font-medium text-warning">确认后立即生效、不可撤销。</p>
      )}

      {status === 'pending' && remainingMs !== null && !expired && (
        <p className="mb-2 text-xs text-muted-foreground">
          剩余 {formatRemaining(remainingMs)} 未确认将自动取消。
        </p>
      )}

      {status === 'pending' && expired && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {card.timeoutNotice ?? '操作已取消，未写入任何数据。'}
        </p>
      )}

      {status === 'pending' && !expired && (
        <>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="app-confirm-word">
            请键入「{confirmWord}」以继续
          </label>
          <Input
            id="app-confirm-word"
            className="mb-2 h-9"
            value={typed}
            disabled={disabled}
            autoComplete="off"
            aria-label={`键入 ${confirmWord} 以继续`}
            onChange={(event) => setTyped(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 border-warning/40 text-warning hover:bg-warning/10"
              disabled={!canConfirm}
              aria-label="确认执行"
              onClick={onAllow}
            >
              <Check aria-hidden="true" className="size-3.5" />
              确认执行
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 border-destructive/30 text-destructive hover:bg-destructive/5"
              disabled={disabled}
              aria-label="取消"
              onClick={onDeny}
            >
              <X aria-hidden="true" className="size-3.5" />
              取消
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
