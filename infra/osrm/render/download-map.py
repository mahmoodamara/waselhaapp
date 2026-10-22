"""Fetch one approved public map snapshot and verify bytes before graph building."""
import hashlib
import json
import pathlib
import re
import ssl
import sys
import urllib.parse
import urllib.request


def download(manifest_path, output_path):
    manifest = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
    url = urllib.parse.urlsplit(manifest["url"])
    if (url.scheme != "https" or url.netloc != "download.geofabrik.de"
            or url.query or url.fragment
            or not re.fullmatch(r"/asia/israel-and-palestine-\d{6}\.osm\.pbf", url.path)):
        raise ValueError("An approved dated Geofabrik HTTPS map URL is required")
    expected_size = manifest["bytes"]
    expected_hash = manifest["sha256"]
    if not isinstance(expected_size, int) or not 0 < expected_size <= 256 * 1024 * 1024:
        raise ValueError("Map size must be positive and at most 256 MiB")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise ValueError("A pinned SHA-256 is required")
    target = pathlib.Path(output_path)
    partial = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    received = 0
    request = urllib.request.Request(manifest["url"], headers={"User-Agent": "Waselha-OSRM-Build/1.0"})
    context = ssl.create_default_context()
    build_ca = pathlib.Path("/run/secrets/build_ca")
    if build_ca.is_file():
        context.load_verify_locations(cafile=str(build_ca))
    try:
        with urllib.request.urlopen(request, timeout=60, context=context) as response, partial.open("wb") as stream:
            if response.status != 200 or response.geturl() != manifest["url"]:
                raise ValueError("Map download must return 200 without a redirect")
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > expected_size:
                    raise ValueError("Map exceeds the pinned size")
                digest.update(chunk)
                stream.write(chunk)
        if received != expected_size or digest.hexdigest() != expected_hash:
            raise ValueError("Map size or SHA-256 mismatch; refusing to build")
        partial.replace(target)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    print(f"Verified public map snapshot: {received} bytes, SHA-256 matched")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: download-map.py map-source.json output.osm.pbf")
    download(sys.argv[1], sys.argv[2])
