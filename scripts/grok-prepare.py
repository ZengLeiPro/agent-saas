from pathlib import Path
p=Path('scripts/grok-followup.py')
s=p.read_text()
old="subprocess.run(['git', '-c', 'user.name=OpenAI', '-c', 'user.email=noreply@openai.com', 'merge', '--no-commit', '--no-ff', 'origin/main'], check=True)"
new='''merge = subprocess.run(['git', '-c', 'user.name=OpenAI', '-c', 'user.email=noreply@openai.com', 'merge', '--no-commit', '--no-ff', 'origin/main'])
if merge.returncode:
    conflicts = subprocess.check_output(['git','diff','--name-only','--diff-filter=U'],text=True).splitlines()
    target='web/src/components/PlatformAdmin/pages/ProviderQuotaPage.tsx'
    if conflicts != [target]:
        raise RuntimeError(f'Unexpected merge conflicts: {conflicts}')
    # main changed loading/error handling and removed the Zhipu help paragraph.
    # Preserve that full version and reapply only our four reviewed additive Grok changes.
    merged = subprocess.check_output(['git','show','origin/main:'+target],text=True)
    merged = "import { GrokQuotaDetails } from './GrokQuotaDetails';\\n" + merged
    before = "  codex_subscription: 'Codex 订阅',"
    assert before in merged
    merged = merged.replace(before,before+"\\n  grok_subscription: 'Grok 订阅',",1)
    before = '  const tones = snapshot.windows'
    assert before in merged
    merged = merged.replace(before,"  if (snapshot.sourceKind === 'grok_subscription' && !snapshot.limitReached && snapshot.windows.length === 0) return { tone: 'warning', label: '额度未知' };\\n"+before,1)
    before = '<CardContent className="space-y-3">'
    assert before in merged
    merged = merged.replace(before,before+"\\n        {snapshot.sourceKind === 'grok_subscription' && <GrokQuotaDetails snapshot={snapshot} />}",1)
    Path(target).write_text(merged)
    subprocess.run(['git','add',target],check=True)
'''
assert old in s
p.write_text(s.replace(old,new,1))
print('Prepared narrow reviewed merge resolution')
