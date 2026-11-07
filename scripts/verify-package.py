#!/usr/bin/env python3
"""Verify generated runtime files and packaged resources without printing config."""
import argparse
import json
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import posixpath
import re
from urllib.parse import urlsplit
from zipfile import ZipFile
from package import build, build_ui, distribution_directory, report_build, validate_configuration


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


def verify(root, manifest, contents, output, *, public_build=False):
    validate_configuration(manifest, contents, public_build=public_build)
    assert json.loads(contents["manifest.json"]) == manifest, "Generated manifest mismatch"
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
    unpacked = output.parent / "unpacked"
    assert {str(path.relative_to(unpacked)) for path in unpacked.rglob("*") if path.is_file()} == expected
    with ZipFile(output) as archive:
        assert len(archive.namelist()) == len(expected) and set(archive.namelist()) == expected
        for name, data in contents.items():
            assert archive.read(name) == data and (unpacked / name).read_bytes() == data, f"Runtime mismatch: {name}"
    print(f"Verified {len(expected)} runtime files, matching API origins/permissions/CSP and ZIP; development files excluded.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public", action="store_true", dest="public_build",
                        help="build and verify a distribution without a Microburbs API key")
    parser.add_argument("--check-only", action="store_true",
                        help="verify existing output without rebuilding or changing files")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    if args.check_only:
        dist = distribution_directory(root, public_build=args.public_build)
        unpacked = dist / "unpacked"
        contents = {path.relative_to(unpacked).as_posix(): path.read_bytes()
                    for path in unpacked.rglob("*") if path.is_file()}
        manifest = json.loads(contents["manifest.json"])
        output = dist / f"microburbs-facts-{manifest['version']}.zip"
    else:
        build_ui(root)
        manifest, contents, output = build(root, public_build=args.public_build)
    verify(root, manifest, contents, output, public_build=args.public_build)
    if not args.check_only:
        report_build(root, contents, output, public_build=args.public_build)


if __name__ == "__main__":
    main()
