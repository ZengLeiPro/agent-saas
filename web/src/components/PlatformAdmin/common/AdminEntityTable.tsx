import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, ChevronsUpDown, RefreshCw, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { EmptyState } from "./EmptyState";
import { TableSkeleton } from "./TableSkeleton";

export type SortDirection = "asc" | "desc";

export interface AdminEntityColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** 默认隐藏（可在「列」下拉里打开） */
  hiddenByDefault?: boolean;
  /**
   * 可排序。**必须同时给 `sortValue`**：`cell` 返回的是 ReactNode，
   * 无法从渲染结果可靠地推导排序键。只给 `sortable` 不给 `sortValue` 视为不可排序。
   */
  sortable?: boolean;
  /** 排序键。返回 null/undefined 的行恒排在末尾（对应「—」空值）。 */
  sortValue?: (row: T) => string | number | null | undefined;
  /** 数字列首次点击排序时降序（运维要看最大耗时/成本，不是最小） */
  sortNumeric?: boolean;
  /** 「列」下拉里的文案；`header` 不是纯字符串时必须给 */
  label?: string;
  /** 不允许隐藏（身份列、操作列） */
  alwaysVisible?: boolean;
}

export interface AdminEntitySortState {
  key: string;
  direction: SortDirection;
}

const HIDDEN_COLUMNS_PREFIX = "admin-table:hidden-columns:";

function readHiddenColumns(storageKey: string | undefined): string[] | null {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(HIDDEN_COLUMNS_PREFIX + storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // 隐私模式 / 配额满 / 脏数据都不该让表格崩掉——退回默认列集合
    return null;
  }
}

function writeHiddenColumns(storageKey: string | undefined, keys: string[]) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(HIDDEN_COLUMNS_PREFIX + storageKey, JSON.stringify(keys));
  } catch {
    /* 持久化失败不影响本次会话的显隐 */
  }
}

/** 空值恒排末尾；数字按数值比、字符串按中文 locale 比（带 numeric 让「第 2 名」排在「第 10 名」前） */
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

function compareSortValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

export function AdminEntityTable<T>({
  title,
  rows,
  columns,
  rowKey,
  loading = false,
  emptyText = "暂无数据",
  emptyState,
  toolbar,
  onRefresh,
  onRowClick,
  selectedRowKey,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  storageKey,
  columnSelector = true,
  defaultSort,
  sortScope,
  skeletonRows = 6,
  containerClassName,
}: {
  title?: string;
  rows: T[];
  columns: AdminEntityColumn<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyText?: string;
  /** 升级形态：传 `<EmptyState>` 可带图标与 CTA；给了它 `emptyText` 就被忽略 */
  emptyState?: ReactNode;
  toolbar?: ReactNode;
  onRefresh?: () => void;
  onRowClick?: (row: T) => void;
  /** 传了才渲染 aria-selected / data-state=selected —— 不虚报「可选中」语义 */
  selectedRowKey?: string | null;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  /** 列显隐持久化的命名空间；不传则本次会话有效、刷新后回默认 */
  storageKey?: string;
  columnSelector?: boolean;
  defaultSort?: AdminEntitySortState;
  /**
   * 排序口径。排序是**客户端**的，所以它只能作用于 `rows` 里已有的数据：
   * - `"page"`：`rows` 只是服务端某一页（cursor / offset 分页）→ 排序只重排当前页，
   *   必须在 UI 上明示，否则「按耗时降序 + 翻下一页」会被误读成全量 Top N。
   * - `"all"`：`rows` 就是全量（服务端一次返回）→ 排序等价于全量排序，不该显示误导性提示。
   *
   * 不传时按「有没有翻页控件」推断，保持既有调用点行为不变。
   * 走服务端排序需要后端 `sort`/`order` 参数，当前 `/admin/users`、`/admin/sessions` 都不支持，
   * 因此这里选择「明示口径」而不是假装全量排序。
   */
  sortScope?: "page" | "all";
  skeletonRows?: number;
  containerClassName?: string;
}) {
  const defaultHidden = useMemo(
    () => columns.filter((column) => column.hiddenByDefault && !column.alwaysVisible).map((column) => column.key),
    [columns],
  );
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(() => readHiddenColumns(storageKey) ?? defaultHidden);
  const [sort, setSort] = useState<AdminEntitySortState | null>(defaultSort ?? null);

  // storageKey 变化（同一组件被复用到另一张表）时重新取该表的偏好
  useEffect(() => {
    setHiddenKeys(readHiddenColumns(storageKey) ?? defaultHidden);
  }, [defaultHidden, storageKey]);

  const setHidden = useCallback((keys: string[]) => {
    setHiddenKeys(keys);
    writeHiddenColumns(storageKey, keys);
  }, [storageKey]);

  const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
  const visibleColumns = useMemo(
    () => columns.filter((column) => column.alwaysVisible || !hiddenSet.has(column.key)),
    [columns, hiddenSet],
  );
  const toggleableColumns = useMemo(
    () => columns.filter((column) => !column.alwaysVisible),
    [columns],
  );

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortValue) return rows;
    const getValue = column.sortValue;
    const factor = sort.direction === "asc" ? 1 : -1;
    // 稳定排序：值相等时保持服务端返回顺序（通常是「最新在前」，是有意义的默认序）
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const diff = compareSortValues(getValue(a.row), getValue(b.row));
        // 空值恒排末尾，不随 asc/desc 翻转——否则「—」会霸占第一屏
        if (diff !== 0 && isEmptyOrdering(getValue(a.row), getValue(b.row))) return diff;
        return diff !== 0 ? diff * factor : a.index - b.index;
      })
      .map((item) => item.row);
  }, [columns, rows, sort]);

  const onToggleSort = useCallback((column: AdminEntityColumn<T>) => {
    if (!column.sortable || !column.sortValue) return;
    const first: SortDirection = column.sortNumeric ? "desc" : "asc";
    setSort((current) => {
      if (current?.key !== column.key) return { key: column.key, direction: first };
      if (current.direction === first) return { key: column.key, direction: first === "asc" ? "desc" : "asc" };
      // 第三次点击回到服务端默认顺序
      return null;
    });
  }, []);

  const paginated = Boolean(onPrev || onNext);
  const effectiveSortScope = sortScope ?? (paginated ? "page" : "all");
  const sortHint = effectiveSortScope === "page"
    ? `点击按此列排序（仅当前页 ${rows.length} 条）`
    : "点击按此列排序";

  const columnCount = visibleColumns.length;
  const alignments = useMemo(
    () => visibleColumns.map((column) => (column.className?.includes("text-right") ? "right" as const : "left" as const)),
    [visibleColumns],
  );

  const headerRow = (
    <TableRow>
      {visibleColumns.map((column) => {
        const sortActive = sort?.key === column.key;
        const canSort = Boolean(column.sortable && column.sortValue);
        return (
          <TableHead
            key={column.key}
            className={column.className}
            aria-sort={canSort ? (sortActive ? (sort?.direction === "asc" ? "ascending" : "descending") : "none") : undefined}
          >
            {canSort ? (
              <button
                type="button"
                onClick={() => onToggleSort(column)}
                className={cn(
                  "group -mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  column.className?.includes("text-right") && "ml-auto flex-row-reverse",
                  sortActive && "text-foreground",
                )}
                title={sortActive ? "点击切换排序，再次点击取消排序" : sortHint}
              >
                <span className="truncate">{column.header}</span>
                {sortActive ? (
                  sort?.direction === "asc"
                    ? <ChevronUp className="size-3.5 shrink-0" />
                    : <ChevronDown className="size-3.5 shrink-0" />
                ) : (
                  <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground" />
                )}
              </button>
            ) : (
              column.header
            )}
          </TableHead>
        );
      })}
    </TableRow>
  );

  return (
    <Card>
      {(title || toolbar || onRefresh || (columnSelector && toggleableColumns.length > 1)) && (
        <CardHeader className="flex-row items-center justify-between gap-3">
          {title && <CardTitle className="text-base">{title}</CardTitle>}
          <div className="flex items-center gap-2">
            {toolbar}
            {columnSelector && toggleableColumns.length > 1 && (
              <ColumnSelector
                columns={toggleableColumns}
                hiddenKeys={hiddenKeys}
                onChange={setHidden}
                onReset={() => setHidden(defaultHidden)}
              />
            )}
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
                刷新
              </Button>
            )}
          </div>
        </CardHeader>
      )}
      <CardContent className="p-0">
        {/* 刷新时（rows 已有）原先完全没有加载指示：不清表是对的，但用户按了刷新看不到任何反馈。
            这里补一条发丝进度线，既不清表也不跳动。 */}
        {loading && rows.length > 0 && (
          <div className="h-0.5 w-full overflow-hidden bg-muted" role="status">
            <div className="h-full w-full animate-pulse bg-primary/60" />
            <span className="sr-only">正在刷新…</span>
          </div>
        )}
        {loading && rows.length === 0 ? (
          <TableSkeleton
            rows={skeletonRows}
            columns={columnCount}
            header={headerRow}
            align={alignments}
            containerClassName={containerClassName}
          />
        ) : rows.length === 0 ? (
          emptyState ?? <EmptyState title={emptyText} compact />
        ) : (
          <div aria-busy={loading || undefined}>
            <Table containerClassName={containerClassName}>
              <TableHeader>{headerRow}</TableHeader>
              <TableBody>
                {sortedRows.map((row) => {
                  const key = rowKey(row);
                  const selected = selectedRowKey != null ? key === selectedRowKey : undefined;
                  return (
                    <TableRow
                      key={key}
                      className={cn(onRowClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring")}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      // 行是可激活的主入口，键盘用户原先完全到不了（只有 onClick）
                      tabIndex={onRowClick ? 0 : undefined}
                      onKeyDown={onRowClick
                        ? (event) => {
                          if (event.key !== "Enter") return;
                          if (event.target !== event.currentTarget) return; // 单元格内的链接/按钮自己处理
                          event.preventDefault();
                          onRowClick(row);
                        }
                        : undefined}
                      aria-selected={selected}
                      data-state={selected ? "selected" : undefined}
                    >
                      {visibleColumns.map((column) => (
                        <TableCell key={column.key} className={column.className}>{column.cell(row)}</TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {(onPrev || onNext) && (
        <div className="flex items-center justify-end gap-2 border-t p-3">
          {sort && effectiveSortScope === "page" && (
            <span className="mr-auto text-2xs text-muted-foreground">
              排序只作用于当前页 {rows.length} 条，跨页排序需按服务端顺序翻页
            </span>
          )}
          <Button variant="outline" size="sm" onClick={onPrev} disabled={loading || !hasPrev}>上一页</Button>
          <Button variant="outline" size="sm" onClick={onNext} disabled={loading || !hasNext}>下一页</Button>
        </div>
      )}
    </Card>
  );
}

/** 只有「一侧为空」时才需要绕过 asc/desc 翻转 */
function isEmptyOrdering(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  return aEmpty !== bEmpty;
}

function columnLabel<T>(column: AdminEntityColumn<T>): string {
  if (column.label) return column.label;
  if (typeof column.header === "string") return column.header;
  if (typeof column.header === "number") return String(column.header);
  return column.key;
}

/**
 * 列显隐选择器。`hiddenByDefault` 字段改造前已存在但**零调用点、零 UI**（死 API），
 * 这里把它接上，并用 localStorage 记住每张表的选择。
 */
function ColumnSelector<T>({
  columns,
  hiddenKeys,
  onChange,
  onReset,
}: {
  columns: AdminEntityColumn<T>[];
  hiddenKeys: string[];
  onChange: (keys: string[]) => void;
  onReset: () => void;
}) {
  const hiddenSet = new Set(hiddenKeys);
  const visibleCount = columns.length - columns.filter((column) => hiddenSet.has(column.key)).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="选择显示的列">
          <SlidersHorizontal className="mr-1 size-3.5" />
          列
          {hiddenKeys.length > 0 && (
            <span className="ml-1 text-2xs text-muted-foreground tabular-nums">{visibleCount}/{columns.length}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-48 overflow-y-auto">
        <DropdownMenuLabel>显示的列</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((column) => {
          const checked = !hiddenSet.has(column.key);
          return (
            <DropdownMenuCheckboxItem
              key={column.key}
              checked={checked}
              // 不允许把最后一列也关掉——空表格没有任何意义
              disabled={checked && visibleCount <= 1}
              onCheckedChange={(next) => {
                const rest = hiddenKeys.filter((key) => key !== column.key);
                onChange(next ? rest : [...rest, column.key]);
              }}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="truncate text-xs">{columnLabel(column)}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-xs" onSelect={() => onReset()}>恢复默认</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
