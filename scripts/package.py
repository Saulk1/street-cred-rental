#!/usr/bin/env python3
"""Build a local or public extension from .env.local; package runtime files only."""
import argparse
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
    chat_token = values.get("CHAT_ACCESS_TOKEN", "")
    if any(ord(char) < 32 or ord(char) == 127 for char in key + chat_token) or chat_token != chat_token.strip():
        raise ValueError("Configuration values must not contain control characters")
    return {"baseUrl": base, "apiKey": key, "dataApiBaseUrl": data_base, "chatToken": chat_token}


def runtime_files(manifest):
    files = ["LICENSE", "manifest.json", "consts.js", "property-api.js", "runtime-config.js",
             "report-endpoints.js", "report-plan.js", "report-store.js", "report-worker.js",
             manifest["background"]["service_worker"], manifest["action"]["default_popup"],
             manifest["options_page"], manifest["side_panel"]["default_path"], "welcome/welcome.html",
             "ui/pages.js", "ui/pages.css", "ui/selection-card.css", "ui/widget.css",
             "assets/2b3d1c2b0be2d1ac87bf7a95fac33e3a.webp",
             *manifest["icons"].values(),
             *(filename for script in manifest.get("content_scripts", [])
               for kind in ("js", "css") for filename in script.get(kind, []))]
    return list(dict.fromkeys(files))


def build_ui(root):
    subprocess.run(["npm", "run", "build"], cwd=root, check=True)


def runtime_source(root, name):
    # Source layout and installed extension paths are intentionally independent.
    # Keep Chrome URLs stable while taking runtime inputs only from extension/.
    if name == "LICENSE":
        return root / name
    if name.startswith("ui/"):
        return root / ".build/runtime" / name
    return root / "extension" / name


def distribution_directory(root, *, public_build=False):
    return root / "dist/public" if public_build else root / "dist"


def build(root, config_path=None, *, public_build=False):
    manifest = json.loads((root / "extension/manifest.json").read_text(encoding="utf-8"))
    config = read_config(config_path or root / ".env.local")
    origins = list(dict.fromkeys(origin for origin in (config["baseUrl"], config["dataApiBaseUrl"]) if origin))
    if origins:
        manifest["host_permissions"] = [origin + "/*" for origin in origins]
        manifest["content_security_policy"]["extension_pages"] = manifest["content_security_policy"]["extension_pages"].replace("connect-src 'none'", "connect-src " + " ".join(origins))
    # Explicitly allowlist public runtime configuration. Database variables are
    # ignored even if someone accidentally adds them to the extension's env file.
    microburbs_config = {"baseUrl": config["baseUrl"], "apiKey": "" if public_build else config["apiKey"]}
    data_config = {"baseUrl": config["dataApiBaseUrl"]}
    chat_config = {"baseUrl": config["dataApiBaseUrl"], "token": "" if public_build else config["chatToken"]}
    generated = {
        "manifest.json": (json.dumps(manifest, indent=2) + "\n").encode(),
        "runtime-config.js": (("// Generated public configuration. API key omitted.\n" if public_build
                               else "// Generated local team configuration. Do not commit.\n")
                              + "globalThis.MICROBURBS_CONFIG = Object.freeze(" + json.dumps(microburbs_config) + ");\n"
                              + "globalThis.DATA_API_CONFIG = Object.freeze(" + json.dumps(data_config) + ");\n"
                              + "globalThis.CHAT_API_CONFIG = Object.freeze(" + json.dumps(chat_config) + ");\n").encode(),
    }
    contents = {name: generated[name] if name in generated else runtime_source(root, name).read_bytes()
                for name in runtime_files(manifest)}
    validate_configuration(manifest, contents, public_build=public_build)
    dist = distribution_directory(root, public_build=public_build)
    dist.mkdir(parents=True, exist_ok=True)
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


def runtime_configuration(contents, name="MICROBURBS_CONFIG"):
    prefix = f"globalThis.{name} = Object.freeze("
    try:
        lines = [line for line in contents["runtime-config.js"].decode().splitlines() if line.startswith(prefix)]
        if len(lines) != 1 or not lines[0].endswith(");"):
            raise ValueError
        config = json.loads(lines[0][len(prefix):-2])
        if not isinstance(config, dict):
            raise ValueError
        return config
    except (KeyError, ValueError, UnicodeError):
        raise ValueError("Invalid generated runtime configuration. Rebuild from the root .env.local.") from None


def validate_configuration(manifest, contents, *, public_build=False):
    microburbs = runtime_configuration(contents)
    data = runtime_configuration(contents, "DATA_API_CONFIG")
    chat = runtime_configuration(contents, "CHAT_API_CONFIG")
    if (set(microburbs) != {"baseUrl", "apiKey"} or set(data) != {"baseUrl"}
            or not all(isinstance(value, str) for value in [*microburbs.values(), *data.values()])):
        raise ValueError("Invalid generated runtime configuration. Rebuild from the root .env.local.")
    if (set(chat) != {"baseUrl", "token"} or not all(isinstance(value, str) for value in chat.values())
            or chat["baseUrl"] != data["baseUrl"] or chat["token"] != chat["token"].strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in chat["token"])):
        raise ValueError("Invalid generated chat configuration. Rebuild from the root .env.local.")
    if public_build and chat["token"]:
        raise ValueError("Public build contains a chat access token")
    if public_build and microburbs["apiKey"]:
        raise ValueError("Public build contains a Microburbs API key")
    origins = []
    for config in (microburbs, data):
        origin = https_origin(config["baseUrl"], "Runtime API origin")
        if origin != config["baseUrl"]:
            raise ValueError("Runtime API origin must be canonical. Rebuild from the root .env.local.")
        if origin and origin not in origins:
            origins.append(origin)
    if manifest.get("host_permissions", []) != [origin + "/*" for origin in origins]:
        raise ValueError("Runtime API origins do not match manifest host permissions. Rebuild the extension.")
    policy = manifest.get("content_security_policy", {}).get("extension_pages", "")
    connections = [part.strip().split()[1:] for part in policy.split(";")
                   if part.strip().split()[:1] == ["connect-src"]]
    if connections != [origins or ["'none'"]]:
        raise ValueError("Runtime API origins do not match manifest connect-src. Rebuild the extension.")


def report_build(root, contents, output, *, public_build=False):
    mode = "public build" if public_build else "local team build"
    print(f"Created {output.relative_to(root)} ({mode})")
    print(f"Chrome Load unpacked folder: {(output.parent / 'unpacked').resolve()}")
    config = runtime_configuration(contents)
    if config.get("apiKey") and config.get("baseUrl"):
        print("Property lookup: configured. Reload the extension, then refresh open webpages.")
    elif public_build:
        print("Property lookup: not configured (public builds omit the API key).")
    else:
        print("Property lookup: not configured. Set MICROBURBS_API_KEY and MICROBURBS_API_BASE_URL "
              "in the repository root .env.local, rebuild, and reload the extension.")
    if not public_build:
        chat = runtime_configuration(contents, "CHAT_API_CONFIG")
        print("Property chat: " + ("configured." if chat["baseUrl"] and chat["token"] else "not configured. Set DATA_API_BASE_URL and CHAT_ACCESS_TOKEN in .env.local to enable it."))
        print("Keep this local build private. Use --public and share only dist/public/.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public", action="store_true", dest="public_build",
                        help="omit the Microburbs API key from the distribution")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parent.parent
    build_ui(root)
    _, contents, output = build(root, public_build=args.public_build)
    report_build(root, contents, output, public_build=args.public_build)


if __name__ == "__main__":
    main()
