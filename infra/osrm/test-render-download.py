"""Unit tests for public map integrity checks; never contact the network."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("download_map", Path(__file__).parent / "render/download-map.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
URL = "https://download.geofabrik.de/asia/israel-and-palestine-261021.osm.pbf"


class Response(io.BytesIO):
    status = 200

    def geturl(self):
        return URL


class MapDownloadTests(unittest.TestCase):
    def run_download(self, body=b"public fixture", expected_body=None, override=None):
        expected_body = body if expected_body is None else expected_body
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "map.osm.pbf"
            manifest = Path(directory) / "manifest.json"
            values = {"url": URL, "bytes": len(expected_body), "sha256": hashlib.sha256(expected_body).hexdigest()}
            values.update(override or {})
            manifest.write_text(json.dumps(values), encoding="utf-8")
            with patch.object(module.urllib.request, "urlopen", return_value=Response(body)) as network:
                try:
                    module.download(manifest, output)
                    return output.read_bytes(), network.call_count
                except Exception:
                    self.assertFalse(output.exists())
                    self.assertFalse(output.with_name(output.name + ".part").exists())
                    raise

    def test_verified_bytes_are_published(self):
        data, calls = self.run_download()
        self.assertEqual(data, b"public fixture")
        self.assertEqual(calls, 1)

    def test_checksum_mismatch_never_publishes_map(self):
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.run_download(b"wrong!", expected_body=b"right!")

    def test_oversized_download_never_publishes_map(self):
        with self.assertRaisesRegex(ValueError, "exceeds"):
            self.run_download(b"too long", expected_body=b"small")

    def test_truncated_download_never_publishes_map(self):
        with self.assertRaisesRegex(ValueError, "size or SHA-256"):
            self.run_download(b"short", expected_body=b"a full map")

    def test_unapproved_or_credentialed_urls_are_rejected_before_network(self):
        for url in ["http://download.geofabrik.de/asia/israel-and-palestine-261021.osm.pbf",
                    "https://example.com/map.osm.pbf", URL + "?token=fixture",
                    URL.replace("https://", "https://user:password@")]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "approved dated"):
                self.run_download(override={"url": url})

    def test_unbounded_size_and_missing_hash_are_rejected(self):
        for override in [{"bytes": 300 * 1024 * 1024}, {"sha256": ""}]:
            with self.subTest(override=override), self.assertRaises(ValueError):
                self.run_download(override=override)


if __name__ == "__main__":
    unittest.main()
