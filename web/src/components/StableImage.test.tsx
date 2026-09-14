import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StableImage } from './StableImage';

function loadImage(image: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
  image.dispatchEvent(new Event('load'));
}

function box(): HTMLElement {
  return document.querySelector('[data-stable-image-box]') as HTMLElement;
}

describe('StableImage', () => {
  it('图片解码前保持与旧占位一致的 240x160 尺寸盒', () => {
    render(<StableImage src="https://example.com/pending.png" alt="pending" />);

    expect(box().style.width).toBe('240px');
    expect(box().style.aspectRatio).toBe('1.5');
    expect(screen.getByAltText('pending').className).toContain('absolute');
  });

  it('首次加载记录自然比例，虚拟行卸载重挂后首帧直接复用', () => {
    const cacheKey = 'stable-remount-image';
    const first = render(
      <StableImage src="https://example.com/image.png" cacheKey={cacheKey} alt="first" />,
    );
    act(() => loadImage(screen.getByAltText('first') as HTMLImageElement, 800, 500));
    expect(box().style.width).toBe('512px');
    expect(box().style.aspectRatio).toBe('1.6');
    first.unmount();

    render(<StableImage src="https://example.com/image.png" cacheKey={cacheKey} alt="second" />);
    expect(box().style.width).toBe('512px');
    expect(box().style.aspectRatio).toBe('1.6');
  });

  it('父级流式更新不替换已加载的图片节点或尺寸盒', () => {
    const view = render(<StableImage src="https://example.com/stream.png" alt="stream" />);
    const image = screen.getByAltText('stream') as HTMLImageElement;
    act(() => loadImage(image, 600, 400));
    const stableBox = box();

    view.rerender(<StableImage src="https://example.com/stream.png" alt="stream updated" />);

    expect(screen.getByAltText('stream updated')).toBe(image);
    expect(box()).toBe(stableBox);
    expect(box().style.aspectRatio).toBe('1.5');
  });

  it('工作区地址解析完成前不撤掉占位盒', async () => {
    let finish: ((url: string) => void) | undefined;
    const resolve = vi.fn(
      () =>
        new Promise<string>((accept) => {
          finish = accept;
        }),
    );
    render(
      <StableImage
        src="workspace/image.png"
        cacheKey="workspace-image"
        resolve={resolve}
        alt="workspace"
      />,
    );

    expect(screen.queryByAltText('workspace')).toBeNull();
    expect(box().style.aspectRatio).toBe('1.5');
    await act(async () => finish?.('https://example.com/resolved.png'));
    expect(screen.getByAltText('workspace')).toBeTruthy();
    expect(box().style.aspectRatio).toBe('1.5');
  });
});
