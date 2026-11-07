"""Run deterministic advisor acceptance checks; old reports remain historical."""
import subprocess
import sys
from pathlib import Path
root = Path(__file__).resolve().parent.parent
for args in [ ['-m','unittest','discover','-s','tests/world_model','-p','test_*.py'],
              ['-m','unittest','discover','-s','tests','-p','compute_test.py'] ]:
    subprocess.run([sys.executable,*args],cwd=root,check=True)
print('Advisor acceptance checks passed. No market-quality or live availability claim is made.')
