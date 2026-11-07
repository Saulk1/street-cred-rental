"""Build/config tests using temporary copies and dummy credentials only."""
import importlib.util
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('extension_package', ROOT / 'scripts/package.py')
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)
verify_spec = importlib.util.spec_from_file_location('verify_package', ROOT / 'scripts/verify-package.py')
verify = importlib.util.module_from_spec(verify_spec)
with mock.patch.dict(sys.modules, {'package': pack}):
    verify_spec.loader.exec_module(verify)


def copy_runtime_tree(root):
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    for name in pack.runtime_files(manifest):
        if name == 'runtime-config.js':
            continue
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(pack.runtime_source(ROOT, name).read_bytes())
    return manifest


class PackageTests(unittest.TestCase):
    def test_chat_settings_and_provider_secrets_are_separated_in_all_builds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            (root / '.env.local').write_text(
                'DATA_API_BASE_URL=https://chat.example.test\n'
                'CHAT_ACCESS_TOKEN=dummy-chat-secret\n'
                'OPENAI_API_KEY=dummy-openai-secret\n'
                'OPENAI_MODEL=server-only-model\n'
                'DATABASE_URL=postgresql://dummy-database-secret\n')
            for public in [False, True]:
                manifest, contents, archive = pack.build(root, public_build=public)
                chat = pack.runtime_configuration(contents, 'CHAT_API_CONFIG')
                self.assertEqual(chat, {'baseUrl': 'https://chat.example.test', 'token': '' if public else 'dummy-chat-secret'})
                self.assertIn(b'../runtime-config.js', contents['options/options.html'])
                for data in contents.values():
                    for secret in [b'dummy-openai-secret', b'server-only-model', b'dummy-database-secret']:
                        self.assertNotIn(secret, data)
                    if public:
                        self.assertNotIn(b'dummy-chat-secret', data)
                with redirect_stdout(io.StringIO()):
                    verify.verify(root, manifest, contents, archive, public_build=public)
                chat['baseUrl'] = 'https://other.example.test'
                changed = dict(contents)
                original = pack.runtime_configuration(contents, 'CHAT_API_CONFIG')
                changed['runtime-config.js'] = contents['runtime-config.js'].replace(json.dumps(original).encode(), json.dumps(chat).encode())
                with self.assertRaisesRegex(ValueError, 'chat configuration'):
                    pack.validate_configuration(manifest, changed)

    def test_every_property_endpoint_uses_generated_env_local_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            (root / '.env.local').write_text(
                'MICROBURBS_API_BASE_URL=https://env-fixture.example.test\n'
                'MICROBURBS_API_KEY=dummy-env-key\n'
                'DATABASE_URL=postgresql://server-only-secret\n')
            _, _, archive = pack.build(root)
            # Exercise the real generated config and shared request client. No
            # live requests or real credentials are used by this regression test.
            result = subprocess.run(['node', '--input-type=module', '--eval', r'''
                import assert from 'node:assert/strict';
                import { readFileSync } from 'node:fs';
                import { join } from 'node:path';
                import vm from 'node:vm';
                const root = process.argv[1];
                const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
                const calls = [];
                let now = 100000;
                class Clock extends Date { static now() { return now; } }
                const context = vm.createContext({
                    Date: Clock, URL, URLSearchParams, AbortController,
                    chrome: { runtime: { getManifest: () => manifest } },
                    setTimeout(fn, delay) {
                        if (delay !== 20000) { now += delay; queueMicrotask(fn); }
                        return 0;
                    },
                    clearTimeout() {},
                    async fetch(url, options) {
                        calls.push({ url, options });
                        return { ok: true, headers: { get: () => null },
                                 json: async () => ({ data: null }) };
                    },
                });
                for (const name of ['runtime-config.js', 'property-api.js']) {
                    vm.runInContext(readFileSync(join(root, name), 'utf8'), context);
                }
                const api = vm.runInContext('PROPERTY_API', context);
                await api.search('26 Tudor St');
                await api.details('GANSW1');
                for (const section of ['market', 'planning', 'schools', 'amenities', 'transport']) {
                    await api.extra('GANSW1', section);
                }
                for (const part of ['sale', 'rent']) await api.extra('GANSW1', 'market', part);
                assert.equal(calls.length, 12);
                for (const { url, options } of calls) {
                    assert.equal(new URL(url).origin, 'https://env-fixture.example.test');
                    assert.equal(options.headers.Authorization, 'Bearer dummy-env-key');
                }
                assert.deepEqual([...new Set(calls.map(({ url }) => new URL(url).pathname))].sort(), [
                    '/v1/geocode/address',
                    ...['basics/all', 'valuation/avm', 'risks/all', 'sale-history-latest',
                        'rent-history-latest', 'development/all', 'schools/nearby',
                        'amenities/nearby', 'transport/nearby'].map(path => '/v1/properties/GANSW1/' + path),
                ].sort());
            ''', str(archive.parent / 'unpacked')], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_private_public_private_builds_preserve_local_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            env = root / '.env.local'
            source = ('MICROBURBS_API_BASE_URL=https://api.example.test\n'
                      'MICROBURBS_API_KEY=dummy-private-key\n'
                      'DATA_API_BASE_URL=https://data.example.test\n'
                      'DATABASE_URL=postgresql://dummy-database-secret\n'
                      'DATABASE_MIGRATION_URL=postgresql://dummy-owner-secret\n')
            env.write_text(source)
            private_files = None
            for public in [False, True, False]:
                with self.subTest(public=public):
                    manifest, contents, archive = pack.build(root, public_build=public)
                    config = pack.runtime_configuration(contents)
                    self.assertEqual(config, {'baseUrl': 'https://api.example.test',
                                              'apiKey': '' if public else 'dummy-private-key'})
                    self.assertEqual(env.read_text(), source)
                    self.assertEqual(manifest['host_permissions'],
                                     ['https://api.example.test/*', 'https://data.example.test/*'])
                    self.assertIn(b'https://data.example.test', contents['runtime-config.js'])
                    with redirect_stdout(io.StringIO()):
                        verify.verify(root, manifest, contents, archive, public_build=public)
                    with ZipFile(archive) as zipped:
                        self.assertEqual(set(zipped.namelist()), set(contents))
                        for name, data in contents.items():
                            self.assertEqual(zipped.read(name), data)
                            self.assertEqual((archive.parent / 'unpacked' / name).read_bytes(), data)
                            self.assertNotIn('.env', name)
                            for secret in [b'dummy-database-secret', b'dummy-owner-secret']:
                                self.assertNotIn(secret, data)
                            if public:
                                self.assertNotIn(b'dummy-private-key', data)
                    local_files = {path.relative_to(root / 'dist/unpacked').as_posix(): path.read_bytes()
                                   for path in (root / 'dist/unpacked').rglob('*') if path.is_file()}
                    local_files['ZIP'] = (root / 'dist/microburbs-facts-0.1.0.zip').read_bytes()
                    if public:
                        self.assertEqual(local_files, private_files)
                        self.assertEqual(archive.parent, root / 'dist/public')
                    else:
                        private_files = local_files

    def test_public_verification_rejects_a_private_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            (root / '.env.local').write_text('MICROBURBS_API_BASE_URL=https://api.example.test\n'
                                             'MICROBURBS_API_KEY=dummy-private-key\n')
            manifest, contents, archive = pack.build(root)
            with self.assertRaisesRegex(ValueError, 'Public build contains a Microburbs API key'):
                verify.verify(root, manifest, contents, archive, public_build=True)

    def test_cli_modes_report_actual_configuration_without_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            env = root / '.env.local'
            source = ('MICROBURBS_API_BASE_URL=https://api.example.test\n'
                      'MICROBURBS_API_KEY=dummy-private-key\n'
                      'DATABASE_URL=postgresql://dummy-database-secret\n')
            env.write_text(source)
            for module in [pack, verify]:
                for public in [False, True]:
                    with self.subTest(command=module.__name__, public=public):
                        output = io.StringIO()
                        with mock.patch.object(module, '__file__', str(root / 'scripts/command.py')), \
                                mock.patch.object(module, 'build_ui') as ui, redirect_stdout(output):
                            module.main(['--public'] if public else [])
                        ui.assert_called_once_with(root.resolve())
                        text = output.getvalue()
                        dist = pack.distribution_directory(root, public_build=public)
                        self.assertIn(str((dist / 'unpacked').resolve()), text)
                        self.assertIn('Property lookup: not configured' if public else 'Property lookup: configured', text)
                        self.assertIn('public build' if public else 'local team build', text)
                        self.assertNotIn('dummy-private-key', text)
                        self.assertNotIn('dummy-database-secret', text)
                        self.assertEqual(env.read_text(), source)

    def test_check_only_detects_manual_edits_without_rebuilding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            (root / '.env.local').write_text('MICROBURBS_API_BASE_URL=https://api.example.test\n'
                                             'MICROBURBS_API_KEY=dummy-private-key\n')
            for public in [False, True]:
                manifest, contents, archive = pack.build(root, public_build=public)
                unpacked = archive.parent / 'unpacked'
                with mock.patch.object(verify, '__file__', str(root / 'scripts/verify-package.py')), \
                        mock.patch.object(verify, 'build_ui') as ui, \
                        mock.patch.object(verify, 'build') as builder, redirect_stdout(io.StringIO()):
                    args = ['--check-only'] + (['--public'] if public else [])
                    verify.main(args)
                    original_zip = archive.read_bytes()
                    original_runtime = (unpacked / 'runtime-config.js').read_bytes()
                    (unpacked / 'runtime-config.js').write_bytes(original_runtime.replace(
                        b'https://api.example.test', b'https://other.example.test'))
                    with self.assertRaisesRegex(ValueError, 'host permissions'):
                        verify.main(args)
                    self.assertEqual(archive.read_bytes(), original_zip)
                    (unpacked / 'runtime-config.js').write_bytes(original_runtime)
                    policy = json.loads(contents['manifest.json'])
                    policy['content_security_policy']['extension_pages'] = "connect-src 'none'"
                    (unpacked / 'manifest.json').write_text(json.dumps(policy))
                    with self.assertRaisesRegex(ValueError, 'connect-src'):
                        verify.main(args)
                    (unpacked / 'manifest.json').write_bytes(contents['manifest.json'])
                    with ZipFile(archive, 'w') as zipped:
                        for name, data in contents.items():
                            zipped.writestr(name, data + b'changed' if name == 'runtime-config.js' else data)
                    with self.assertRaisesRegex(AssertionError, 'Runtime mismatch: runtime-config.js'):
                        verify.main(args)
                    ui.assert_not_called()
                    builder.assert_not_called()

    def test_validation_checks_both_origins_and_rejects_broad_or_duplicate_policies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            (root / '.env.local').write_text('MICROBURBS_API_BASE_URL=https://api.example.test\n'
                                             'DATA_API_BASE_URL=https://data.example.test\n')
            manifest, contents, _ = pack.build(root)
            for permissions, policy, message in [
                (['https://api.example.test/*'], None, 'host permissions'),
                (['https://*/*'], None, 'host permissions'),
                (None, 'connect-src https://api.example.test', 'connect-src'),
                (None, "connect-src https://api.example.test https://data.example.test; connect-src 'none'", 'connect-src'),
            ]:
                changed = json.loads(json.dumps(manifest))
                if permissions is not None:
                    changed['host_permissions'] = permissions
                if policy is not None:
                    changed['content_security_policy']['extension_pages'] = policy
                with self.assertRaisesRegex(ValueError, message):
                    pack.validate_configuration(changed, contents)

    def test_lookup_diagnostic_requires_both_origin_and_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            copy_runtime_tree(root)
            for settings in ['', 'MICROBURBS_API_KEY=dummy-private-key\n',
                             'MICROBURBS_API_BASE_URL=https://api.example.test\n']:
                with self.subTest(settings=settings):
                    (root / '.env.local').write_text(settings)
                    _, contents, archive = pack.build(root)
                    output = io.StringIO()
                    with redirect_stdout(output):
                        pack.report_build(root, contents, archive)
                    self.assertIn('Property lookup: not configured.', output.getvalue())
                    self.assertNotIn('dummy-private-key', output.getvalue())

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
            self.assertEqual(pack.read_config(path), {'baseUrl': '', 'apiKey': '', 'dataApiBaseUrl': '', 'chatToken': ''})
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
