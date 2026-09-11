from pathlib import Path
p=Path('scripts/grok-followup.py')
s=p.read_text()
a=s.index('# Include the migration proof and all source/workspace tests as independent diagnostics.')
b=s.index("put('docs/grok-subscription.md'",a)
s=s[:a]+s[b:]
p.write_text(s)
print('Kept application commit code-only; workflow updates use the authorized connector separately')
