"""Build/config tests using temporary copies and dummy credentials only."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('extension_package', ROOT / 'scripts/package.py')
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class PackageTests(unittest.TestCase):
    def test_config_and_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_manifest = json.loads((ROOT / 'manifest.json').read_text())
            for name in pack.runtime_files(source_manifest):
                if name == 'runtime-config.js':
                    continue
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            (root / '.env.local').write_text('MICROBURBS_API_BASE_URL=https://api.example.test\nMICROBURBS_API_KEY="dummy-key"\n')
            manifest, contents, archive = pack.build(root)
            self.assertEqual(manifest['host_permissions'], ['https://api.example.test/*'])
            self.assertIn('connect-src https://api.example.test', manifest['content_security_policy']['extension_pages'])
            self.assertEqual(json.loads((root / 'manifest.json').read_text()), source_manifest)
            self.assertIn(b'dummy-key', contents['runtime-config.js'])
            self.assertFalse(any(name.endswith('.yaml') or '.env' in name or name.startswith('tests/') for name in contents))
            with ZipFile(archive) as zipped:
                self.assertEqual(len(zipped.namelist()), len(set(zipped.namelist())))
                for name, data in contents.items():
                    self.assertEqual(zipped.read(name), data)
                    self.assertEqual((root / 'dist/unpacked' / name).read_bytes(), data)
            (root / 'dist/unpacked/stale.txt').write_text('old generated output')
            pack.build(root)
            self.assertFalse((root / 'dist/unpacked/stale.txt').exists())

    def test_missing_key_is_supported(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / '.env.local'
            self.assertEqual(pack.read_config(path), {'baseUrl': '', 'apiKey': ''})
            path.write_text('export MICROBURBS_API_BASE_URL=https://api.example.test/\nMICROBURBS_API_KEY=\n')
            self.assertEqual(pack.read_config(path)['apiKey'], '')

    def test_invalid_origins_and_quotes_are_rejected_without_echoing_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / '.env.local'
            for origin in ['http://api.example.test', 'https://secret@api.example.test', 'https://api.example.test/path',
                           'https://api.example.test?key=secret', 'https://api.example.test#secret', 'https://api.example.test:444']:
                path.write_text('MICROBURBS_API_BASE_URL=' + origin)
                with self.assertRaises(ValueError) as raised:
                    pack.read_config(path)
                self.assertNotIn('secret', str(raised.exception))
            path.write_text('MICROBURBS_API_KEY="unclosed')
            with self.assertRaises(ValueError):
                pack.read_config(path)


if __name__ == '__main__':
    unittest.main()
