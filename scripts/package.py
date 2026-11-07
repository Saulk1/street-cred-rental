#!/usr/bin/env python3
"""Build a local team extension from .env.local; package runtime files only."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile


def https_origin(value, name):
    if any(ord(char) < 32 for char in value):
        raise ValueError(f"{name} must not contain control characters")
    value = value.rstrip("/")
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise ValueError(f"{name} must be a valid HTTPS origin") from None
    if parsed.scheme != "https" or not parsed.hostname or not re.fullmatch(r"[A-Za-z0-9.-]+", parsed.hostname) or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError(f"{name} must be an HTTPS origin without credentials, a path, query or fragment")
    try:
        port = parsed.port
    except ValueError:
        raise ValueError(f"{name} has an invalid port") from None
    if port not in (None, 443):
        raise ValueError(f"{name} must use the default HTTPS port")
    return "https://" + parsed.hostname


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
    base = https_origin(values.get("MICROBURBS_API_BASE_URL", ""), "MICROBURBS_API_BASE_URL")
    data_base = https_origin(values.get("DATA_API_BASE_URL", ""), "DATA_API_BASE_URL")
    key = values.get("MICROBURBS_API_KEY", "")
    if any(ord(char) < 32 for char in key):
        raise ValueError("Configuration values must not contain control characters")
    return {"baseUrl": base, "apiKey": key, "dataApiBaseUrl": data_base}


def runtime_files(manifest):
    files = ["LICENSE", "manifest.json", "consts.js", "property-api.js", "runtime-config.js",
             manifest["background"]["service_worker"], manifest["action"]["default_popup"],
             manifest["options_page"], manifest["side_panel"]["default_path"], "welcome/welcome.html",
             "ui/pages.js", "ui/pages.css", "ui/selection-card.css", "ui/widget.css",
             *manifest["icons"].values(),
             *(filename for script in manifest.get("content_scripts", [])
               for kind in ("js", "css") for filename in script.get(kind, []))]
    return list(dict.fromkeys(files))


def build_ui(root):
    subprocess.run(["npm", "run", "build"], cwd=root, check=True)


def runtime_source(root, name):
    compiled = root / ".build/runtime" / name
    return compiled if name.startswith("ui/") and compiled.exists() else root / name


def build(root, config_path=None):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    config = read_config(config_path or root / ".env.local")
    origins = list(dict.fromkeys(origin for origin in (config["baseUrl"], config["dataApiBaseUrl"]) if origin))
    if origins:
        manifest["host_permissions"] = [origin + "/*" for origin in origins]
        manifest["content_security_policy"]["extension_pages"] = manifest["content_security_policy"]["extension_pages"].replace("connect-src 'none'", "connect-src " + " ".join(origins))
    # Explicitly allowlist public runtime configuration. Database variables are
    # ignored even if someone accidentally adds them to the extension's env file.
    microburbs_config = {"baseUrl": config["baseUrl"], "apiKey": config["apiKey"]}
    data_config = {"baseUrl": config["dataApiBaseUrl"]}
    generated = {
        "manifest.json": (json.dumps(manifest, indent=2) + "\n").encode(),
        "runtime-config.js": ("// Generated local team configuration. Do not commit.\n"
                              + "globalThis.MICROBURBS_CONFIG = Object.freeze(" + json.dumps(microburbs_config) + ");\n"
                              + "globalThis.DATA_API_CONFIG = Object.freeze(" + json.dumps(data_config) + ");\n").encode(),
    }
    contents = {name: generated[name] if name in generated else runtime_source(root, name).read_bytes()
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
    build_ui(root)
    _, _, output = build(root)
    print(f"Created {output.relative_to(root)} and dist/unpacked (local team build)")
    if not read_config(root / ".env.local")["apiKey"]:
        print("No API key configured: note saving works; property lookup shows setup instructions.")


if __name__ == "__main__":
    main()
