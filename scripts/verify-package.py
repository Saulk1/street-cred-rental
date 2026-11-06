#!/usr/bin/env python3
"""Verify generated runtime files and packaged resources without printing config."""
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import urlsplit
from zipfile import ZipFile
from package import build, build_ui


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
    build_ui(root)
    manifest, contents, output = build(root)
    pages = [manifest["action"]["default_popup"], manifest["options_page"],
             manifest["side_panel"]["default_path"], "welcome/welcome.html"]
    expected = {"LICENSE", "manifest.json", manifest["background"]["service_worker"], *pages,
                *manifest["icons"].values(), *manifest["action"]["default_icon"].values()}

    def resource_path(owner, resource):
        filename = posixpath.normpath(posixpath.join(posixpath.dirname(owner), resource))
        if urlsplit(resource).scheme or urlsplit(resource).netloc or PurePosixPath(filename).is_absolute() or ".." in PurePosixPath(filename).parts:
            raise ValueError("Resource outside extension")
        return filename

    pending = [manifest["background"]["service_worker"]]
    seen = set()
    while pending:
        owner = pending.pop()
        if owner in seen:
            continue
        seen.add(owner)
        for resource in re.findall(r'importScripts\(["\']([^"\']+)["\']\)', contents[owner].decode()):
            name = resource_path(owner, resource)
            expected.add(name)
            pending.append(name)
    for script in manifest.get("content_scripts", []):
        for kind in ("js", "css"):
            expected.update(script.get(kind, []))
    for resources in manifest.get("web_accessible_resources", []):
        expected.update(resources["resources"])
    for page in pages:
        parser = Resources()
        parser.feed(contents[page].decode())
        expected.update(resource_path(page, path) for path in parser.paths)
    assert set(contents) == expected, "Runtime allowlist mismatch"
    unpacked = root / "dist/unpacked"
    assert {str(path.relative_to(unpacked)) for path in unpacked.rglob("*") if path.is_file()} == expected
    with ZipFile(output) as archive:
        assert len(archive.namelist()) == len(expected) and set(archive.namelist()) == expected
        for name, data in contents.items():
            assert archive.read(name) == data and (unpacked / name).read_bytes() == data, f"Runtime mismatch: {name}"
    print(f"Verified {len(expected)} runtime files, generated manifest/config and ZIP; development files excluded.")


if __name__ == "__main__":
    main()
