export interface OnboardMemberRow {
  row: number;
  name: string;
  phone: string;
  departmentPath: string;
  employeeNo?: string;
}

const HEADER_ALIASES: Record<string, keyof Omit<OnboardMemberRow, 'row'>> = {
  name: 'name',
  姓名: 'name',
  phone: 'phone',
  手机号: 'phone',
  departmentPath: 'departmentPath',
  部门路径: 'departmentPath',
  employeeNo: 'employeeNo',
  工号: 'employeeNo',
};

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/u, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('CSV 引号没有闭合');
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/u, ''));
    rows.push(row);
  }
  return rows;
}

export function parseOnboardMembersCsv(text: string): OnboardMemberRow[] {
  const rows = parseRows(text).filter((row) => row.some((value) => value.trim() !== ''));
  const headers = rows.shift();
  if (!headers) throw new Error('成员 CSV 为空');
  const columns = new Map<keyof Omit<OnboardMemberRow, 'row'>, number>();
  headers.forEach((header, index) => {
    const mapped = HEADER_ALIASES[header.trim()];
    if (mapped) columns.set(mapped, index);
  });
  for (const required of ['name', 'phone', 'departmentPath'] as const) {
    const labels = { name: '姓名', phone: '手机号', departmentPath: '部门路径' } as const;
    if (!columns.has(required)) throw new Error(`成员 CSV 缺少列：${labels[required]}`);
  }
  return rows.map((values, index) => {
    const read = (key: keyof Omit<OnboardMemberRow, 'row'>) =>
      values[columns.get(key) ?? -1]?.trim() ?? '';
    const employeeNo = read('employeeNo');
    return {
      row: index + 2,
      name: read('name'),
      phone: read('phone'),
      departmentPath: read('departmentPath'),
      ...(employeeNo ? { employeeNo } : {}),
    };
  });
}
