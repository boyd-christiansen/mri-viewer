"""Loopback-only QA server for the encrypted sharing build."""
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

site = Path(__file__).resolve().parents[1] / ".share" / "site"
headers = json.loads((site / "vercel.json").read_text())["headers"][0]["headers"]


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        for header in headers:
            self.send_header(header["key"], header["value"])
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8767), functools.partial(Handler, directory=str(site)))
    print("Sharing preview: http://127.0.0.1:8767", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
