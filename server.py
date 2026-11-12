"""Local static-file server for the pure browser application."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)


if __name__ == "__main__":
    address = ("127.0.0.1", int(os.environ.get("PORT", "8081")))
    print(f"Static app: http://localhost:{address[1]} (Ctrl+C to stop)")
    ThreadingHTTPServer(address, Handler).serve_forever()
