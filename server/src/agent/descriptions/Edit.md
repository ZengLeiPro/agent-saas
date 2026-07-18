对工作区文本文件执行精确字符串替换。
`old_string` 必须恰好匹配一次（或传 `replace_all: true`）。
新建文件请用 Write。
大于 1MB 的文件或敏感路径（.ky-agent/settings.json、.env、.git/、.ssh/、.npmrc）会被拒绝。
