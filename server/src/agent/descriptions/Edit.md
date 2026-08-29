对工作区文本文件执行一个或多个文本替换。

单处编辑使用 `old_string` / `new_string`；批量编辑使用 `edits: [{old_string, new_string, replace_all?}]`。批量项全部针对原始文件匹配，确认互不重叠后一次写回；不要让后一项依赖前一项刚生成的文本。

匹配顺序：先精确匹配；失败后自动归一化 CRLF/LF、行尾空白、弯引号、Unicode 破折号和特殊空格再尝试。原文件的 UTF-8 BOM 与主行尾格式会保留。未传 `replace_all: true` 时，每个 `old_string` 必须只命中一次；单次调用最多执行 10000 处替换。

成功结果包含替换计数、首个变更行和有界 unified diff metadata。新建文件请用 Write。输入文件或替换结果大于 1MB 时会拒绝；敏感路径（.ky-agent/settings.json、.env、.git/、.ssh/、.npmrc）会被拒绝。
