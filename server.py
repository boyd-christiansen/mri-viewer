#!/usr/bin/env python3
"""MRI Viewer: offline loopback-only application. No external requests."""
from __future__ import annotations

import argparse
import json
import math
import mimetypes
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from imaging import Catalog, DATA, ROOT
from import_disc import import_disc, mounted_volumes


class Application:
    def __init__(self, data=DATA):
        self.data = Path(data)
        self.catalog = Catalog(data)
        self.lock = threading.Lock()
        self.status = {"phase": "idle"}

    def start_import(self, source):
        allowed = {item["path"] for item in mounted_volumes()}
        if source not in allowed:
            raise ValueError("Choose one of the currently mounted discs.")
        with self.lock:
            if self.status["phase"] in {"copying", "indexing"}:
                raise ValueError("An import is already running.")
            self.status = {"phase": "copying", "completed": 0, "total": 0}

        def run():
            try:
                def progress(update):
                    self.status = update
                import_disc(source, self.data, progress)
                self.status = {"phase": "indexing"}
                catalog = Catalog(self.data)
                self.catalog = catalog
                self.status = {"phase": "done", "message": f"Copied and verified. {len(catalog.frames)} image frames available."}
            except Exception as error:
                self.status = {"phase": "error", "message": str(error)}
        threading.Thread(target=run, daemon=True).start()


def handler_for(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MRIViewer/1.0"

        def log_message(self, format, *args):
            # Do not log image IDs, filenames, metadata, or reports.
            pass

        def valid_host(self):
            return self.headers.get("Host", "") in {
                f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

        def send(self, content, content_type="application/json", status=200, filename=None):
            if isinstance(content, (dict, list)):
                content = json.dumps(content, allow_nan=False).encode()
            elif isinstance(content, str):
                content = content.encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            if not self.valid_host():
                self.send({"error": "Local access only."}, status=403)
                return
            parsed = urlparse(self.path)
            route = unquote(parsed.path)
            query = parse_qs(parsed.query)
            try:
                catalog = app.catalog
                if route == "/api/health":
                    self.send({"application": "mri-viewer", "version": 1})
                elif route == "/api/library":
                    self.send(catalog.public())
                elif route == "/api/spatial":
                    self.send(catalog.spatial())
                elif route == "/api/volumes":
                    self.send(mounted_volumes())
                elif route == "/api/import-status":
                    self.send(app.status)
                elif route.startswith("/api/frame/"):
                    self.send(catalog.frame_info(route.rsplit("/", 1)[-1]))
                elif route.startswith("/api/image/"):
                    def value(name):
                        raw = query.get(name, [None])[0]
                        result = float(raw) if raw is not None else None
                        if result is not None and not math.isfinite(result):
                            raise ValueError("Invalid window value.")
                        return result
                    content = catalog.render(route.rsplit("/", 1)[-1], value("center"), value("width"), query.get("invert") == ["1"])
                    self.send(content, "image/png")
                elif route.startswith("/api/document/"):
                    file_id = route.rsplit("/", 1)[-1]
                    if file_id not in {doc["id"] for doc in catalog.documents}:
                        raise KeyError(file_id)
                    content, content_type = catalog.document(file_id)
                    self.send(content, content_type)
                elif route.startswith("/api/original/"):
                    path = catalog.files[route.rsplit("/", 1)[-1]]
                    self.send(path.read_bytes(), "application/octet-stream", filename="original.dcm")
                else:
                    assets = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css", "/spatial.js": "spatial.js", "/spatial.css": "spatial.css", "/spatial.js.LICENSE.txt": "spatial.js.LICENSE.txt"}
                    if route not in assets:
                        self.send({"error": "Not found."}, status=404)
                    else:
                        path = ROOT / "web" / assets[route]
                        self.send(path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            except KeyError:
                self.send({"error": "This image or document is not in the local library."}, status=404)
            except (ValueError, IndexError) as error:
                self.send({"error": str(error)}, status=400)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.send({"error": f"This file could not be decoded: {error}"}, status=422)

        def do_POST(self):
            origin = self.headers.get("Origin")
            allowed_origin = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
            if not self.valid_host() or origin not in allowed_origin or self.headers.get("Content-Type") != "application/json":
                self.send({"error": "Only requests from this viewer are allowed."}, status=403)
                return
            try:
                if self.path != "/api/import":
                    self.send({"error": "Not found."}, status=404)
                    return
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= 8192:
                    raise ValueError("Invalid request size.")
                request = json.loads(self.rfile.read(length))
                app.start_import(request["source"])
                self.send({"ok": True}, status=202)
            except (ValueError, KeyError, TypeError) as error:
                self.send({"error": str(error)}, status=400)
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", type=Path, default=DATA)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    app = Application(args.data)
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(app))
            break
        except OSError as error:
            if error.errno != 48:
                raise
    else:
        raise SystemExit("No available port; close an older viewer and try again.")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"MRI Viewer: {url}", flush=True)
    print(f"{len(app.catalog.series)} series · {len(app.catalog.frames)} frames. Keep this window open while viewing.", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
