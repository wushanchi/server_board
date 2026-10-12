#!/usr/bin/env python3
"""Read-only npu-smi history endpoint for Server Board."""

import hmac
import json
import os
import re
import ssl
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_npu_smi(text):
    """Parse the two-line-per-device table emitted by `npu-smi info`."""
    devices = []
    pending = None
    for line in text.splitlines():
        if not (line.startswith("|") and line.endswith("|")):
            continue
        columns = [part.strip() for part in line[1:-1].split("|")]
        if len(columns) < 3:
            continue
        first, second, third = columns[:3]
        identity = re.fullmatch(r"(\d+)\s+(.+)", first)
        if identity and second.upper() in {"OK", "WARNING", "ALARM", "UNKNOWN", "ISOLATED", "FAULT"}:
            values = re.findall(r"\d+(?:\.\d+)?", third)
            pending = {
                "id": identity.group(1),
                "model": identity.group(2).strip(),
                "health": second.upper(),
                "power_w": number(values[0]) if len(values) >= 1 else None,
                "temperature_c": number(values[1]) if len(values) >= 2 else None,
                "utilization": None,
                "hbm_used_mb": None,
                "hbm_total_mb": None,
            }
            continue
        if pending and re.fullmatch(r"\d+\s+\d+", first):
            # Device row: AI Core %, device memory used/total, HBM used/total.
            match = re.search(r"([\d.]+)\s+([\d.]+)\s*/\s*([\d.]+)\s+([\d.]+)\s*/\s*([\d.]+)", third)
            if match:
                pending["utilization"] = number(match.group(1))
                pending["hbm_used_mb"] = number(match.group(4))
                pending["hbm_total_mb"] = number(match.group(5))
            else:
                # Some firmware omits device memory and prints only AI Core + HBM.
                match = re.search(r"([\d.]+)\s+([\d.]+)\s*/\s*([\d.]+)", third)
                if match:
                    pending["utilization"] = number(match.group(1))
                    pending["hbm_used_mb"] = number(match.group(2))
                    pending["hbm_total_mb"] = number(match.group(3))
            devices.append(pending)
            pending = None
    return devices


class Collector:
    def __init__(self, interval=30, retention_minutes=1440, command="npu-smi"):
        self.interval = interval
        self.command = command
        self.samples = deque(maxlen=max(2, retention_minutes * 60 // interval + 1))
        self.lock = threading.Lock()
        self.last_error = None

    def collect(self):
        try:
            process = subprocess.run([self.command, "info"], capture_output=True, text=True, timeout=10, check=True)
            devices = parse_npu_smi(process.stdout)
            if not devices:
                raise ValueError("npu-smi output did not contain a recognized NPU device table")
            sample = {"timestamp": datetime.now(timezone.utc).isoformat(), "devices": devices}
            with self.lock:
                self.samples.append(sample)
                self.last_error = None
        except (OSError, subprocess.SubprocessError, ValueError) as error:
            with self.lock:
                self.last_error = str(error)[:300]

    def run(self):
        while True:
            start = time.monotonic()
            self.collect()
            time.sleep(max(1, self.interval - (time.monotonic() - start)))

    def history(self, minutes):
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        with self.lock:
            samples = [sample for sample in self.samples if datetime.fromisoformat(sample["timestamp"]) >= cutoff]
            error = self.last_error
        return {"interval_seconds": self.interval, "samples": samples, "last_error": error}


class Handler(BaseHTTPRequestHandler):
    server_version = "ServerBoardAgent/0.1"

    def _headers(self, status, origin=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if origin and origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._headers(status, self.headers.get("Origin"))
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if origin not in self.server.allowed_origins:
            self._headers(403)
            return
        self._headers(204, origin)

    def do_GET(self):
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.allowed_origins:
            self._json(403, {"error": "origin not allowed"})
            return
        authorization = self.headers.get("Authorization", "")
        expected = "Bearer " + self.server.token
        if not hmac.compare_digest(authorization, expected):
            self._json(401, {"error": "unauthorized"})
            return
        url = urlparse(self.path)
        if url.path != "/api/v1/history":
            self._json(404, {"error": "not found"})
            return
        try:
            minutes = int(parse_qs(url.query).get("minutes", ["30"])[0])
            if not 1 <= minutes <= self.server.retention_minutes:
                raise ValueError()
        except ValueError:
            self._json(400, {"error": "minutes must be within retention period"})
            return
        self._json(200, self.server.collector.history(minutes))

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args), flush=True)


def main():
    token = os.environ.get("SB_TOKEN", "")
    if len(token) < 24:
        raise SystemExit("SB_TOKEN must be a random token of at least 24 characters")
    host = os.environ.get("SB_HOST", "127.0.0.1")
    port = int(os.environ.get("SB_PORT", "8765"))
    interval = int(os.environ.get("SB_INTERVAL", "30"))
    retention = int(os.environ.get("SB_RETENTION_MINUTES", "1440"))
    if not 5 <= interval <= 3600 or not 30 <= retention <= 10080:
        raise SystemExit("SB_INTERVAL must be 5..3600 and SB_RETENTION_MINUTES 30..10080")
    cert, key = os.environ.get("SB_TLS_CERT"), os.environ.get("SB_TLS_KEY")
    if bool(cert) != bool(key):
        raise SystemExit("SB_TLS_CERT and SB_TLS_KEY must be set together")
    if host not in {"127.0.0.1", "localhost", "::1"} and not cert:
        raise SystemExit("TLS is required when binding beyond loopback")
    collector = Collector(interval, retention, os.environ.get("SB_NPU_SMI", "npu-smi"))
    server = ThreadingHTTPServer((host, port), Handler)
    server.token = token
    server.collector = collector
    server.retention_minutes = retention
    server.allowed_origins = {value.strip().rstrip("/") for value in os.environ.get(
        "SB_ALLOWED_ORIGINS", "https://wushanchi.github.io,http://127.0.0.1:5173"
    ).split(",") if value.strip()}
    if cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=collector.run, daemon=True).start()
    print(f"Server Board agent listening on {host}:{port}, interval {interval}s", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
