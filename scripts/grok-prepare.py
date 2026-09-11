from pathlib import Path
p=Path('scripts/release/grok-migration-evidence.mjs')
s=p.read_text();old='const plan = createMigrationPlan({ baseline, target });';assert old in s
s=s.replace(old,"const changedPaths = execFileSync('git', ['diff', '--name-only', '-z', `${baseline}...${target}`], { encoding: 'utf8' }).split('\\0').filter(Boolean);\nconst plan = createMigrationPlan({ baseline, target, changedPaths });")
p.write_text(s)
p=Path('scripts/grok-apply.py');s=p.read_text()
old="const prefix=(size==='short'?'g':'grok_long_prefix_')+randomUUID().replaceAll('-','');prefixes.push(prefix);"
new="const nonce=randomUUID().replaceAll('-','');const prefix=size==='short'?'g'+nonce.slice(0,6):'grok_long_prefix_'+nonce;prefixes.push(prefix);"
assert old in s;s=s.replace(old,new,1);p.write_text(s)
p=Path('docs/grok-subscription-rollout.md');s=p.read_text().replace('<prefix>_grok_refresh_journal','<prefix>_grok_credential_refresh_journal');p.write_text(s)
p=Path('docs/reviews/grok-subscription-implementation.md');s=p.read_text().replace('`provider-catalog.ts`、`usage.ts`','`provider-catalog.ts`、`usage.ts`、`stream.ts`');p.write_text(s)
print('Fixed complete source diff input, short/long table-prefix branches and exact journal suffix')
