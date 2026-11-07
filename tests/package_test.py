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
                target.write_bytes(pack.runtime_source(ROOT, name).read_bytes())
            (root / '.env.local').write_text('MICROBURBS_API_BASE_URL=https://api.example.test\nMICROBURBS_API_KEY="dummy-key"\n')
            manifest, contents, archive = pack.build(root)
            self.assertEqual(manifest['host_permissions'], ['https://api.example.test/*'])
            self.assertIn('connect-src https://api.example.test', manifest['content_security_policy']['extension_pages'])
            self.assertEqual(json.loads((root / 'manifest.json').read_text()), source_manifest)
            self.assertIn(b'dummy-key', contents['runtime-config.js'])
            self.assertFalse(any(name.endswith('.yaml') or '.env' in name or name.startswith('tests/') for name in contents))
            self.assertFalse(any(name.startswith(("src/", ".build/", "node_modules/", ".agents/", ".tools/")) or name.endswith((".tsx", ".map")) for name in contents))
            self.assertIn(b'globalThis.DATA_API_CONFIG = Object.freeze({"baseUrl": ""})', contents['runtime-config.js'])
            self.assertIn("ui/injected.js", contents)
            self.assertIn("ui/selection-card.css", contents)
            self.assertNotIn(b"@import", contents["ui/pages.css"])
            # Only host positioning rules are installed into the host page.
            host_css = contents["content-script/selection-card.css"].decode()
            self.assertNotIn("@layer", host_css)
            self.assertNotIn("@theme", host_css)
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
            self.assertEqual(pack.read_config(path), {'baseUrl': '', 'apiKey': '', 'dataApiBaseUrl': ''})
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

    def test_data_api_origins_and_database_exclusion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = json.loads((ROOT / 'manifest.json').read_text())
            for name in pack.runtime_files(manifest):
                if name == 'runtime-config.js':
                    continue
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(pack.runtime_source(ROOT, name).read_bytes())
            for name in ['api/health.ts', 'server/db/index.ts', 'drizzle/0000.sql',
                         'data/first.csv', 'data/second.csv', '.env.server.local']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('server-only-marker')
            env = root / '.env.local'
            for microburbs, data, expected in [
                ('', '', []),
                ('https://microburbs.example.test', '', ['https://microburbs.example.test']),
                ('', 'https://data.example.test/', ['https://data.example.test']),
                ('https://microburbs.example.test', 'https://data.example.test:443',
                 ['https://microburbs.example.test', 'https://data.example.test']),
                ('https://same.example.test', 'https://same.example.test', ['https://same.example.test']),
            ]:
                with self.subTest(microburbs=microburbs, data=data):
                    env.write_text(f'MICROBURBS_API_BASE_URL={microburbs}\nDATA_API_BASE_URL={data}\n'
                                   'DATABASE_URL=postgresql://dummy-runtime-secret\n'
                                   'DATABASE_MIGRATION_URL=postgresql://dummy-owner-secret\n')
                    generated, contents, archive = pack.build(root)
                    self.assertEqual(generated.get('host_permissions', []), [origin + '/*' for origin in expected])
                    directive = "connect-src " + (' '.join(expected) if expected else "'none'")
                    self.assertEqual(generated['content_security_policy']['extension_pages'].split('; ')[-1], directive)
                    self.assertIn(b'globalThis.DATA_API_CONFIG', contents['runtime-config.js'])
                    with ZipFile(archive) as zipped:
                        self.assertEqual(set(zipped.namelist()), set(pack.runtime_files(manifest)))
                        for name in zipped.namelist():
                            for secret in [b'dummy-runtime-secret', b'dummy-owner-secret', b'server-only-marker']:
                                self.assertNotIn(secret, zipped.read(name))
                            self.assertFalse(name.startswith(('api/', 'server/', 'drizzle/', 'data/')))
                            self.assertFalse(name.endswith(('.csv', '.tsv')))

    def test_invalid_data_api_origin_is_rejected_without_echoing_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / '.env.local'
            for origin in ['http://data.example.test', 'https://secret@data.example.test',
                           'https://data.example.test/path', 'https://data.example.test?secret',
                           'https://data.example.test#secret', 'https://data.example.test:444',
                           'https://data.example.test:secret', 'https://[secret]', 'https://data.example.test\t']:
                path.write_text('DATA_API_BASE_URL="' + origin + '"')
                with self.subTest(origin=origin), self.assertRaises(ValueError) as raised:
                    pack.read_config(path)
                self.assertNotIn('secret', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
