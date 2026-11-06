#!/usr/bin/env python3
"""Package only extension runtime files using the Python standard library."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main():
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    files = [
        "LICENSE",
        "manifest.json",
        manifest["background"]["service_worker"],
        manifest["action"]["default_popup"],
        "popup/popup.css",
        "popup/popup.js",
        manifest["options_page"],
        "options/options.css",
        "options/options.js",
        manifest["side_panel"]["default_path"],
        "sidepanel/sidepanel.css",
        "sidepanel/sidepanel.js",
        "welcome/welcome.html",
        "welcome/welcome.css",
        *manifest["icons"].values(),
        *(filename for script in manifest.get("content_scripts", [])
          for kind in ("js", "css") for filename in script.get(kind, [])),
    ]
    # Validate before creating or replacing the archive.
    for filename in files:
        if not (root / filename).is_file():
            raise FileNotFoundError(f"Missing extension file: {filename}")

    output = root / "dist" / f"microburbs-facts-{manifest['version']}.zip"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for filename in files:
            archive.write(root / filename, arcname=filename)
    print(f"Created {output.relative_to(root)} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
