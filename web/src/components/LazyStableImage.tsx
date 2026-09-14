import { lazy, Suspense } from 'react';
import type { StableImageProps } from './StableImage';

const StableImage = lazy(() =>
  import('./StableImage').then((module) => ({ default: module.StableImage })),
);

export function LazyStableImage(props: StableImageProps) {
  return (
    <Suspense
      fallback={
        <span className="relative block h-40 w-60 max-w-full overflow-hidden rounded-lg border border-border bg-muted" />
      }
    >
      <StableImage {...props} />
    </Suspense>
  );
}
