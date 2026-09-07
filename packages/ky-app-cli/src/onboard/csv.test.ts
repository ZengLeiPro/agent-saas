import { describe, expect, it } from 'vitest';

import { parseOnboardMembersCsv } from './csv.js';

describe('parseOnboardMembersCsv', () => {
  it('支持中文表头、BOM、CRLF、引号与可选工号', () => {
    expect(
      parseOnboardMembersCsv(
        '\uFEFF姓名,手机号,部门路径,工号\r\n"张,三",13800138000,"总部/销售",E001\r\n',
      ),
    ).toEqual([
      {
        row: 2,
        name: '张,三',
        phone: '13800138000',
        departmentPath: '总部/销售',
        employeeNo: 'E001',
      },
    ]);
  });

  it('缺必填列时明确拒绝', () => {
    expect(() => parseOnboardMembersCsv('姓名,手机号\n张三,13800138000')).toThrow('部门路径');
  });
});
