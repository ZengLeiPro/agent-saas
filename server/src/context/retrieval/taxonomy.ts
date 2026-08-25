const MAX_FILTER_VALUE_LENGTH = 128;

/** Context 检索过滤值统一采用 NFKC、trim、大小写无关语义。 */
export function normalizeContextFilterValues(values?: readonly string[]): string[] | null {
  if (!values?.length) return null;
  return [...new Set(values.map(normalizeContextFilterValue).filter(Boolean))];
}

export function normalizeContextFilterValue(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').slice(0, MAX_FILTER_VALUE_LENGTH);
}

/** 对外 kind 优先表达业务实体类型；recordKind 作为独立字段保留。 */
export function contextDisplayKind(entityType: unknown, recordKind: unknown): string {
  const entity = typeof entityType === 'string' ? entityType.normalize('NFKC').trim() : '';
  if (entity) return entity[0]!.toUpperCase() + entity.slice(1).toLowerCase();
  return typeof recordKind === 'string' && recordKind.trim() ? recordKind.trim() : 'record';
}
