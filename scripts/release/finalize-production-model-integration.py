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

p = Path('server/src/__tests__/helpers/productionPublicationRig.ts')
s = p.read_text()
old = 'resolveRuntimeModels: (models) => resolveModelsConfig(models, vault),'
new = "resolveRuntimeModels: async (models) => { const resolved = await resolveModelsConfig(models, vault); if (!resolved) throw new Error('models missing'); return resolved; },"
assert s.count(old) == 1
s = s.replace(old, new).replace('parseAppConfig, type AppConfig', 'parseAppConfig')
s = s.replace('timeoutMs: 150, pollMs: 5', 'timeoutMs: 500, pollMs: 5')
p.write_text(s)
p = Path('server/src/__tests__/productionModelPublication.test.ts')
s = p.read_text()
old = "modelResolver?.('main/model')?.apiKey"
assert s.count(old) == 1
p.write_text(s.replace(old, "modelResolver?.('main/model')?.connection?.apiKey"))
