import { type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface AdminEntityColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  hiddenByDefault?: boolean;
}

export function AdminEntityTable<T>({
  title,
  rows,
  columns,
  rowKey,
  loading = false,
  emptyText = "暂无数据",
  toolbar,
  onRefresh,
  onRowClick,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  title?: string;
  rows: T[];
  columns: AdminEntityColumn<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyText?: string;
  toolbar?: ReactNode;
  onRefresh?: () => void;
  onRowClick?: (row: T) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const visibleColumns = columns.filter(column => !column.hiddenByDefault);
  return (
    <Card>
      {(title || toolbar || onRefresh) && (
        <CardHeader className="flex-row items-center justify-between gap-3">
          {title && <CardTitle className="text-base">{title}</CardTitle>}
          <div className="flex items-center gap-2">
            {toolbar}
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                <RefreshCw className={cn("mr-1 h-3.5 w-3.5", loading && "animate-spin")} />
                刷新
              </Button>
            )}
          </div>
        </CardHeader>
      )}
      <CardContent className="p-0">
        {loading && rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{emptyText}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {visibleColumns.map(column => (
                  <TableHead key={column.key} className={column.className}>{column.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <TableRow
                  key={rowKey(row)}
                  className={cn(onRowClick && "cursor-pointer hover:bg-muted/30")}
                  onClick={() => onRowClick?.(row)}
                >
                  {visibleColumns.map(column => (
                    <TableCell key={column.key} className={column.className}>{column.cell(row)}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {(onPrev || onNext) && (
        <div className="flex justify-end gap-2 border-t p-3">
          <Button variant="outline" size="sm" onClick={onPrev} disabled={loading || !hasPrev}>上一页</Button>
          <Button variant="outline" size="sm" onClick={onNext} disabled={loading || !hasNext}>下一页</Button>
        </div>
      )}
    </Card>
  );
}
