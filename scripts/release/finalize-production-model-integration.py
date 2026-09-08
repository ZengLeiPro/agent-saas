#!/usr/bin/env python3
"""Temporary exact-source integration fix; removed from the final PR."""
from pathlib import Path

p = Path('server/src/config/adminConfigMutationHttp.ts')
s = p.read_text()
replacements = {
    "res.status(503).json({ code: error.code, error: '配置已提交，但最终生效确认未完成；请重新读取服务端状态，不要盲目重复提交' });":
        "res.status(500).json({ code: error.code, error: error.message });",
    "res.status(503).json({ code: error.code, error: '配置恢复尚未完成，已暂停新配置执行；请检查配置发布恢复状态' });":
        "res.status(500).json({ code: error.code, error: error.message });",
}
for old, new in replacements.items():
    if s.count(old) != 1:
        raise RuntimeError('Expected exactly one matching HTTP error branch')
    s = s.replace(old, new)
p.write_text(s)
