import { type ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * 表格骨架屏：泛化自 `FileBrowser/FileListSkeleton.tsx`（原本只在一处使用）。
 *
 * 为什么要它：改造前 24 处加载态全是「居中 spinner + 加载中…」，容器高度 h-40 与
 * 真实表格高度不一致，数据到达时整块布局抖动一次。骨架屏的价值不是「更好看」，
 * 而是**结构先出、数据后填**——列数、行高、对齐方式在加载期就已经确定。
 *
 * 传入 `header` 时表头是**真实表头**（列名可读），只有单元格是占位块。
 * `align` 让右对齐列的占位条也靠右，避免加载完成时数字列出现横向跳动
 * （数字右对齐 + tabular-nums 是既有优势，骨架屏不能把它丢掉）。
 */
export function TableSkeleton({
  rows = 6,
  columns = 4,
  header,
  align,
  className,
  containerClassName,
  label = "正在加载数据…",
}: {
  rows?: number;
  columns?: number;
  /** 真实表头（<TableRow> 内容）。不传则渲染一行占位表头。 */
  header?: ReactNode;
  /** 每列对齐；缺省视为 left。长度不足时其余列按 left 处理。 */
  align?: ReadonlyArray<"left" | "right">;
  className?: string;
  containerClassName?: string;
  /** 屏幕阅读器用的加载提示，同时作为测试锚点 */
  label?: string;
}) {
  const columnCount = Math.max(1, columns);
  return (
    <Table aria-busy="true" className={className} containerClassName={containerClassName}>
      <caption className="sr-only">{label}</caption>
      <TableHeader>
        {header ?? (
          <TableRow>
            {Array.from({ length: columnCount }).map((_, index) => (
              <TableCell key={index} className="h-10">
                <Skeleton className="h-3 w-16" />
              </TableCell>
            ))}
          </TableRow>
        )}
      </TableHeader>
      <TableBody>
        {Array.from({ length: Math.max(1, rows) }).map((_, rowIndex) => (
          <TableRow key={rowIndex} className="hover:bg-transparent">
            {Array.from({ length: columnCount }).map((_, columnIndex) => (
              <TableCell key={columnIndex}>
                <Skeleton
                  className={cn(
                    "h-3",
                    align?.[columnIndex] === "right" && "ml-auto",
                  )}
                  // 宽度按 (行,列) 确定性推导：同一列各行宽度不同，看起来像真实数据，
                  // 但每次渲染完全一致，不会在测试里产生随机快照。
                  style={{ width: `${cellWidthPercent(rowIndex, columnIndex)}%` }}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function cellWidthPercent(rowIndex: number, columnIndex: number): number {
  return 45 + ((rowIndex * 13 + columnIndex * 29) % 45);
}
