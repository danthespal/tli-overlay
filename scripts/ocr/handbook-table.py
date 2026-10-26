import json, sys, re
sys.stdout.reconfigure(encoding='utf-8')
rows = json.load(open(sys.argv[1], encoding='utf-8-sig'))
# Handbook order groups rows by Whisper type (88 = 20 + 32 + 16 + 16 + 4).
# Types are inferred from in-game card titles/tooltips (see 07-choice-screens.md).
groups = [(20, 'Switch pool (Timemark 100-100)'), (32, 'Wealth'), (16, 'Armament'), (16, 'Wonder'), (4, 'Boss Whisper')]
out, i = [], 0
for n, g in groups:
    for r in rows[i:i+n]:
        eff = re.sub(r'^\+ (\d)', r'+\1', r['effect'])
        found = 'Undiscovered' not in eff
        out.append(dict(group=g, rarity=r['rarity'], timemark=r['timemark'] if found else None,
                        effect=eff if found else None, source=r['file']))
    i += n
assert i == len(rows) == 88, len(rows)
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
md = []
for _, g in groups:
    part = [o for o in out if o['group'] == g]
    md.append(f"### {g}  ({sum(o['effect'] is not None for o in part)}/{len(part)} discovered)\n")
    md.append('| Rarity | Timemark | Effect |\n|---|---|---|')
    for o in part:
        md.append(f"| {o['rarity']} | {o['timemark'] or '?'} | {o['effect'] or '*undiscovered*'} |")
    md.append('')
open(sys.argv[3], 'w', encoding='utf-8').write('\n'.join(md))
print('\n'.join(md))
