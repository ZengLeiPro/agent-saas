import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useResizePanel } from '@/hooks/useResizePanel';

import { ResizablePanelDivider } from './ResizablePanelDivider';

function ResizablePanelHarness() {
  const { ratio, containerRef, onDividerMouseDown, onDividerDoubleClick } = useResizePanel();

  return (
    <div ref={containerRef} data-testid="resize-container" className="flex h-96 w-[1000px]">
      <output data-testid="ratio">{ratio}</output>
      <div className="h-full w-2.5">
        <ResizablePanelDivider
          label="调整右侧面板宽度"
          onMouseDown={onDividerMouseDown}
          onDoubleClick={onDividerDoubleClick}
        />
      </div>
    </div>
  );
}

describe('ResizablePanelDivider', () => {
  it('提供贯穿面板高度的拖拽热区与居中的悬停提示线', () => {
    const onMouseDown = vi.fn();
    const onDoubleClick = vi.fn();
    const { container } = render(
      <div className="h-96 w-2.5">
        <ResizablePanelDivider
          label="调整右侧面板宽度"
          onMouseDown={onMouseDown}
          onDoubleClick={onDoubleClick}
        />
      </div>,
    );

    const divider = screen.getByRole('separator', { name: '调整右侧面板宽度' });
    const indicator = container.querySelector('[aria-hidden="true"]');

    expect(divider.className).toContain('h-full');
    expect(divider.className).toContain('w-full');
    expect(indicator?.className).toContain('top-1/2');
    expect(indicator?.className).toContain('group-hover:bg-foreground/75');

    fireEvent.mouseDown(divider);
    fireEvent.doubleClick(divider);

    expect(onMouseDown).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('按住分隔条后可以调整右侧面板宽度，并可双击复位', () => {
    render(<ResizablePanelHarness />);

    const container = screen.getByTestId('resize-container');
    const divider = screen.getByRole('separator', { name: '调整右侧面板宽度' });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 384,
      width: 1000,
      height: 384,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 600 });
    fireEvent.mouseUp(window);

    expect(screen.getByTestId('ratio').textContent).toBe('0.4');
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    fireEvent.doubleClick(divider);

    expect(screen.getByTestId('ratio').textContent).toBe('0.5');
  });
});
