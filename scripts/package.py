#!/usr/bin/env python3
"""Build a local team extension from .env.local; package runtime files only."""
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


def read_config(path):
    values = {}
    if path.exists():
        for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            name, separator, value = line.partition("=")
            if not separator:
                raise ValueError(f"Invalid configuration assignment on line {index}")
            value = value.strip()
            if value[:1] in ('"', "'"):
                if len(value) < 2 or value[-1] != value[0]:
                    raise ValueError(f"Unclosed configuration quote on line {index}")
                value = value[1:-1]
            else:
                value = value.split(" #", 1)[0].strip()
            values[name.strip()] = value
    base = values.get("MICROBURBS_API_BASE_URL", "").rstrip("/")
    key = values.get("MICROBURBS_API_KEY", "")
    if any(ord(char) < 32 for char in base + key):
        raise ValueError("Configuration values must not contain control characters")
    if base:
        parsed = urlsplit(base)
        if parsed.scheme != "https" or not parsed.hostname or not re.fullmatch(r"[A-Za-z0-9.-]+", parsed.hostname) or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
            raise ValueError("MICROBURBS_API_BASE_URL must be an HTTPS origin without credentials, a path, query or fragment")
        try:
            port = parsed.port
        except ValueError:
            raise ValueError("MICROBURBS_API_BASE_URL has an invalid port") from None
        if port not in (None, 443):
            raise ValueError("MICROBURBS_API_BASE_URL must use the default HTTPS port")
        base = "https://" + parsed.hostname
    return {"baseUrl": base, "apiKey": key}


def runtime_files(manifest):
    files = ["LICENSE", "manifest.json", "consts.js", "property-api.js", "runtime-config.js",
             manifest["background"]["service_worker"], manifest["action"]["default_popup"],
             "popup/popup.css", "popup/popup.js", manifest["options_page"],
             "options/options.css", "options/options.js", manifest["side_panel"]["default_path"],
             "sidepanel/sidepanel.css", "sidepanel/sidepanel.js", "welcome/welcome.html", "welcome/welcome.css",
             *manifest["icons"].values(),
             *(filename for script in manifest.get("content_scripts", [])
               for kind in ("js", "css") for filename in script.get(kind, []))]
    return list(dict.fromkeys(files))


def build(root, config_path=None):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    config = read_config(config_path or root / ".env.local")
    if config["baseUrl"]:
        origin = config["baseUrl"]
        manifest["host_permissions"] = [origin + "/*"]
        manifest["content_security_policy"]["extension_pages"] = manifest["content_security_policy"]["extension_pages"].replace("connect-src 'none'", "connect-src " + origin)
    generated = {
        "manifest.json": (json.dumps(manifest, indent=2) + "\n").encode(),
        "runtime-config.js": ("// Generated local team configuration. Do not commit.\n"
                              + "globalThis.MICROBURBS_CONFIG = Object.freeze(" + json.dumps(config) + ");\n").encode(),
    }
    contents = {name: generated[name] if name in generated else (root / name).read_bytes()
                for name in runtime_files(manifest)}
    dist = root / "dist"
    dist.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="build-", dir=dist) as temporary:
        staging = Path(temporary) / "unpacked"
        staging.mkdir()
        for name, data in contents.items():
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        unpacked = dist / "unpacked"
        if unpacked.exists():
            shutil.rmtree(unpacked)
        staging.rename(unpacked)
    output = dist / f"microburbs-facts-{manifest['version']}.zip"
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            archive.writestr(name, data)
    return manifest, contents, output


def main():
    root = Path(__file__).resolve().parent.parent
    _, _, output = build(root)
    print(f"Created {output.relative_to(root)} and dist/unpacked (local team build)")
    if not read_config(root / ".env.local")["apiKey"]:
        print("No API key configured: note saving works; property lookup shows setup instructions.")


if __name__ == "__main__":
    main()
