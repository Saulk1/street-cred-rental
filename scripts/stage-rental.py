"""Stage team-only rental JSON artifacts; never run during extension packaging."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', nargs='?', default=str(root / 'rental-world-model' / 'data'))
args = parser.parse_args()
source = Path(args.source)
target = root / '.private' / 'rental'
target.mkdir(parents=True, exist_ok=True)
names = ['fair_rent_model.json', 'for_rent_snapshot.json']
for name in names:
    if (source / name).resolve() != (target / name).resolve():
        shutil.copyfile(source / name, target / name)
model = json.loads((target / names[0]).read_text())
snapshot = json.loads((target / names[1]).read_text())
manifest = {'schema': 1, 'collectedAt': snapshot['collected_at'], 'modelVersion': model['version'],
            'files': {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in names}}
manifest['version'] = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Staged private rental artifacts:', manifest['version'][:12], manifest['collectedAt'])
