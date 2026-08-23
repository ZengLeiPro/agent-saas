import { lazy, Suspense } from 'react';
import type { CitationSegment } from '@agent/shared';

import { CitationCard } from './CitationCard';

const ContextCitationCard = lazy(async () => {
  const module = await import('./ContextCitationCard');
  return { default: module.ContextCitationCard };
});

export function MessageCitationCard({ citation, sessionId }: {
  citation: CitationSegment;
  sessionId?: string | null;
}) {
  return 'contextId' in citation
    ? (
        <Suspense fallback={<span className="text-xs text-muted-foreground">正在加载引用…</span>}>
          <ContextCitationCard contextId={citation.contextId} label={citation.label} sessionId={sessionId} />
        </Suspense>
      )
    : <CitationCard doc={citation.doc} page={citation.page} label={citation.label} />;
}
