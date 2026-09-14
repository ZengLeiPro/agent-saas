import { useCallback, useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ImageLightbox } from './ImageLightbox';

const UNKNOWN_WIDTH = 240;
const UNKNOWN_ASPECT_RATIO = 3 / 2;
const MAX_HEIGHT = 320;
const MAX_WIDTH = 960;
const DIMENSION_CACHE_LIMIT = 500;

interface ImageDimensions {
  width: number;
  height: number;
}

const dimensionsBySource = new Map<string, ImageDimensions>();

function rememberDimensions(key: string, dimensions: ImageDimensions): void {
  if (dimensionsBySource.has(key)) dimensionsBySource.delete(key);
  dimensionsBySource.set(key, dimensions);
  if (dimensionsBySource.size > DIMENSION_CACHE_LIMIT) {
    const oldest = dimensionsBySource.keys().next().value;
    if (oldest) dimensionsBySource.delete(oldest);
  }
}

function stableBox(dimensions?: ImageDimensions): { width: number; aspectRatio: number } {
  if (!dimensions) return { width: UNKNOWN_WIDTH, aspectRatio: UNKNOWN_ASPECT_RATIO };
  const aspectRatio = dimensions.width / dimensions.height;
  return {
    width: Math.min(dimensions.width, MAX_HEIGHT * aspectRatio, MAX_WIDTH),
    aspectRatio,
  };
}

export interface StableImageProps {
  src: string;
  alt?: string;
  cacheKey?: string;
  resolve?: () => Promise<string>;
  enableLightbox?: boolean;
  className?: string;
}

/**
 * 给消息图片提供跨解析、解码和虚拟行重挂的稳定尺寸盒。
 *
 * 图片绝对定位在盒内，因此 URL 解析完成但图片尚未解码时不会先塌成 0 高度；
 * 首次读到自然尺寸后缓存比例，同一图片被虚拟列表重挂时首帧即可恢复精确尺寸。
 */
export function StableImage({
  src,
  alt,
  cacheKey,
  resolve,
  enableLightbox = false,
  className,
}: StableImageProps) {
  const key = cacheKey ?? src;
  const cachedDimensions = dimensionsBySource.get(key);
  const [dimensionState, setDimensionState] = useState<{
    key: string;
    dimensions?: ImageDimensions;
  }>(() => ({ key, dimensions: cachedDimensions }));
  const dimensions = dimensionState.key === key ? dimensionState.dimensions : cachedDimensions;
  const box = stableBox(dimensions);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(resolve ? null : src);
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLightboxOpen(false);
    if (!resolve) {
      setResolvedSrc(src);
      return;
    }

    let cancelled = false;
    setResolvedSrc(null);
    resolve()
      .then((url) => {
        if (!cancelled) setResolvedSrc(url);
      })
      .catch(() => {
        if (!cancelled) setResolvedSrc(src);
      });
    return () => {
      cancelled = true;
    };
  }, [resolve, src]);

  const handleLoad = useCallback(
    (element: HTMLImageElement) => {
      const next = { width: element.naturalWidth, height: element.naturalHeight };
      if (
        !Number.isFinite(next.width) ||
        !Number.isFinite(next.height) ||
        next.width <= 0 ||
        next.height <= 0
      )
        return;
      rememberDimensions(key, next);
      setDimensionState((current) =>
        current.key === key &&
        current.dimensions?.width === next.width &&
        current.dimensions.height === next.height
          ? current
          : { key, dimensions: next },
      );
    },
    [key],
  );

  return (
    <>
      <span
        data-stable-image-box
        className={cn(
          'relative block max-w-full overflow-hidden rounded-lg border border-border bg-muted shadow-sm',
          enableLightbox &&
            resolvedSrc &&
            !failed &&
            'cursor-pointer transition-shadow hover:shadow-md',
          className,
        )}
        style={{ width: box.width, aspectRatio: `${box.aspectRatio}` }}
        onClick={enableLightbox && resolvedSrc && !failed ? () => setLightboxOpen(true) : undefined}
      >
        {resolvedSrc && !failed ? (
          <img
            src={resolvedSrc}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 m-0 h-full w-full object-contain"
            onLoad={(event) => handleLoad(event.currentTarget)}
            onError={() => setFailed(true)}
          />
        ) : (
          <span
            className={cn(
              'absolute inset-0 flex items-center justify-center bg-muted',
              !failed && 'animate-pulse',
            )}
          >
            {failed ? <ImageOff className="size-5 text-muted-foreground/60" /> : null}
          </span>
        )}
      </span>
      {lightboxOpen && resolvedSrc ? (
        <ImageLightbox src={resolvedSrc} alt={alt ?? ''} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}
