#!/usr/bin/env python3
"""Rebuild the extension ZIP and verify its runtime files and local resources."""

from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
from urllib.parse import urlsplit
from zipfile import ZipFile


class Resources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ("img", "script") and attrs.get("src"):
            self.paths.append(attrs["src"])
        if tag == "link" and attrs.get("href"):
            self.paths.append(attrs["href"])


def main():
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    pages = [manifest["action"]["default_popup"], manifest["options_page"],
             manifest["side_panel"]["default_path"], "welcome/welcome.html"]
    expected = {"LICENSE", "manifest.json", manifest["background"]["service_worker"], *pages,
                *manifest["icons"].values(), *manifest["action"]["default_icon"].values()}
    worker = manifest["background"]["service_worker"]
    worker_source = (root / worker).read_text(encoding="utf-8")
    # This classic worker uses single bundled paths in importScripts calls.
    for resource in re.findall(r'importScripts\(["\']([^"\']+)["\']\)', worker_source):
        filename = posixpath.normpath(posixpath.join(posixpath.dirname(worker), resource))
        if urlsplit(resource).scheme or PurePosixPath(filename).is_absolute() or ".." in PurePosixPath(filename).parts:
            raise ValueError(f"Expected a bundled worker import: {resource}")
        expected.add(filename)
    for script in manifest.get("content_scripts", []):
        for kind in ("js", "css"):
            expected.update(script.get(kind, []))
    for resources in manifest.get("web_accessible_resources", []):
        expected.update(resources["resources"])
    for page in pages:
        parser = Resources()
        parser.feed((root / page).read_text(encoding="utf-8"))
        for resource in parser.paths:
            url = urlsplit(resource)
            if url.scheme or url.netloc:
                raise ValueError(f"Expected a bundled resource in {page}: {resource}")
            filename = posixpath.normpath(posixpath.join(posixpath.dirname(page), url.path))
            if PurePosixPath(filename).is_absolute() or ".." in PurePosixPath(filename).parts:
                raise ValueError(f"Resource outside the extension: {filename}")
            expected.add(filename)

    subprocess.run([sys.executable, str(root / "scripts/package.py")], check=True)
    output = root / "dist" / f"microburbs-facts-{manifest['version']}.zip"
    with ZipFile(output) as archive:
        actual = archive.namelist()
        if len(actual) != len(set(actual)) or set(actual) != expected:
            raise ValueError(f"ZIP allowlist mismatch: missing={expected - set(actual)}, "
                             f"unexpected={set(actual) - expected}")
        for filename in expected:
            if archive.read(filename) != (root / filename).read_bytes():
                raise ValueError(f"ZIP differs from source: {filename}")
    print(f"Verified {len(expected)} runtime files; no development tooling in ZIP.")


if __name__ == "__main__":
    main()
