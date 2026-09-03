import type { ReactNode } from 'react';
import { LockKeyhole, ShieldOff } from 'lucide-react';

import { EntityIcons, StatusIcons } from '@/lib/icons';
import { cn } from '@/lib/utils';

export type ManagementStateKind = 'readonly' | 'forbidden' | 'error' | 'noscope';

const stateIcons = {
  readonly: LockKeyhole,
  forbidden: ShieldOff,
  error: StatusIcons.error,
  noscope: EntityIcons.org,
} as const;

export function StateBlock({
  kind,
  title,
  description,
  action,
}: {
  kind: ManagementStateKind;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const Icon = stateIcons[kind];
  return (
    <div
      className={cn(
        'mx-auto flex max-w-2xl flex-col items-center rounded-2xl border border-dashed bg-card px-6 py-14 text-center',
        kind === 'error' && 'border-destructive/30',
      )}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/8 text-primary">
        <Icon className="size-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
