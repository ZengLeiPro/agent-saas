from pathlib import Path
p=Path('scripts/release/grok-migration-evidence.mjs')
s=p.read_text();old='const plan = createMigrationPlan({ baseline, target });';assert old in s
s=s.replace(old,"const changedPaths = execFileSync('git', ['diff', '--name-only', '-z', `${baseline}...${target}`], { encoding: 'utf8' }).split('\\0').filter(Boolean);\nconst plan = createMigrationPlan({ baseline, target, changedPaths });")
p.write_text(s)
p=Path('scripts/grok-apply.py');s=p.read_text()
old="const prefix=(size==='short'?'g':'grok_long_prefix_')+randomUUID().replaceAll('-','');prefixes.push(prefix);"
new="const nonce=randomUUID().replaceAll('-','');const prefix=size==='short'?'g'+nonce.slice(0,6):'grok_long_prefix_'+nonce;prefixes.push(prefix);"
assert old in s;s=s.replace(old,new,1)
marker='# Format bound evidence before calculating hashes; the repository hooks remain enabled.'
assert marker in s
s=s.replace(marker,"""# Normalize new PR files before binding hashes; never reformat unrelated legacy files or workflows.
new_paths=subprocess.check_output(['git','diff','--name-only','--diff-filter=A','origin/main...HEAD'],text=True).splitlines()
new_paths+=subprocess.check_output(['git','ls-files','--others','--exclude-standard'],text=True).splitlines()
new_paths=sorted({path for path in new_paths if Path(path).is_file() and Path(path).suffix in ['.ts','.tsx','.js','.mjs','.md','.json'] and not path.startswith('.github/')})
if new_paths: subprocess.run(['pnpm','exec','prettier','--write',*new_paths],check=True)
"""+marker,1)
s+='\nsubprocess.run(["node","scripts/check-max-lines-ratchet.mjs","--prune"],check=True)\n'
p.write_text(s)
p=Path('docs/grok-subscription-rollout.md');s=p.read_text().replace('<prefix>_grok_refresh_journal','<prefix>_grok_credential_refresh_journal');p.write_text(s)
p=Path('docs/reviews/grok-subscription-implementation.md');s=p.read_text().replace('`provider-catalog.ts`、`usage.ts`','`provider-catalog.ts`、`usage.ts`、`stream.ts`');p.write_text(s)
print('Fixed source-plan inputs and exact names; formatted new source before binding evidence; ratchets only shrink')
