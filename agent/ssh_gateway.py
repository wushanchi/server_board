#!/usr/bin/env python3
"""Authenticated HTTP gateway for sampling remote Ascend hosts over SSH."""

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import paramiko

from server_board_agent import parse_npu_smi


def fingerprint(key):
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def validate_target(host, port):
    if not isinstance(host, str) or not host or len(host) > 253 or any(c in host for c in " /\\:@?#\r\n"):
        raise ValueError("invalid SSH host")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("invalid SSH port")
    return host, port


def open_transport(host, port):
    connection = socket.create_connection((host, port), timeout=8)
    try:
        transport = paramiko.Transport(connection)
        transport.banner_timeout = 8
        transport.auth_timeout = 10
        transport.start_client(timeout=8)
        return transport
    except Exception:
        connection.close()
        raise


def probe(host, port):
    transport = open_transport(*validate_target(host, port))
    try:
        key = transport.get_remote_server_key()
        return {"fingerprint": fingerprint(key), "algorithm": key.get_name()}
    finally:
        transport.close()


def connect(host, port, username, password, expected_fingerprint):
    validate_target(host, port)
    if not isinstance(username, str) or not 1 <= len(username) <= 128 or any(c in username for c in "\r\n"):
        raise ValueError("invalid SSH username")
    if not isinstance(password, str) or not password or len(password) > 4096:
        raise ValueError("invalid SSH password")
    if not isinstance(expected_fingerprint, str) or not expected_fingerprint.startswith("SHA256:"):
        raise ValueError("SSH host fingerprint required")
    transport = open_transport(host, port)
    try:
        actual = fingerprint(transport.get_remote_server_key())
        if not hmac.compare_digest(actual, expected_fingerprint):
            raise ValueError("SSH host fingerprint changed; password was not sent")
        transport.auth_password(username, password, fallback=False)
        if not transport.is_authenticated():
            raise ValueError("SSH authentication failed")
        return transport
    except Exception:
        transport.close()
        raise


def purge_sessions(server):
    with server.sessions_lock:
        expired = [key for key, session in server.sessions.items()
                   if session.stop_event.is_set() or time.monotonic() - session.last_access >= 3600]
        sessions = [server.sessions.pop(key) for key in expired]
    for session in sessions:
        session.close()


class SSHSession:
    def __init__(self, transport, interval, retention_minutes=1440):
        self.transport = transport
        self.interval = interval
        self.samples = deque(maxlen=retention_minutes * 60 // interval + 1)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.last_error = None
        self.last_access = time.monotonic()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def collect(self):
        try:
            if not self.transport.is_active():
                raise ConnectionError("SSH connection closed; reconnect required")
            channel = self.transport.open_session(timeout=10)
            try:
                channel.settimeout(12)
                channel.exec_command("npu-smi info")
                output = channel.makefile("rb").read(1024 * 1024 + 1)
                if len(output) > 1024 * 1024:
                    raise ValueError("npu-smi output too large")
                if channel.recv_exit_status() != 0:
                    raise ValueError("npu-smi info failed on remote host")
            finally:
                channel.close()
            devices = parse_npu_smi(output.decode("utf-8", errors="replace"))
            if not devices:
                raise ValueError("npu-smi output did not contain a recognized NPU device table")
            with self.lock:
                self.samples.append({"timestamp": datetime.now(timezone.utc).isoformat(), "devices": devices})
                self.last_error = None
        except (OSError, EOFError, paramiko.SSHException, ValueError, ConnectionError) as error:
            with self.lock:
                self.last_error = str(error)[:300]

    def run(self):
        while not self.stop_event.is_set() and time.monotonic() - self.last_access < 3600:
            started = time.monotonic()
            self.collect()
            self.stop_event.wait(max(1, self.interval - (time.monotonic() - started)))
        self.transport.close()

    def history(self, minutes):
        self.last_access = time.monotonic()
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        with self.lock:
            samples = [sample for sample in self.samples if datetime.fromisoformat(sample["timestamp"]) >= cutoff]
            return {"interval_seconds": self.interval, "samples": samples, "last_error": self.last_error}

    def close(self):
        self.stop_event.set()
        self.transport.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "ServerBoardSSHGateway/0.1"

    def _send(self, status, payload=None):
        body = b"" if status == 204 else json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _allowed(self):
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.allowed_origins:
            self._send(403, {"error": "origin not allowed"})
            return False
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
            self._send(401, {"error": "unauthorized"})
            return False
        return True

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 8192:
            raise ValueError("invalid request size")
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError("expected JSON object")
        return data

    def do_OPTIONS(self):
        if self.headers.get("Origin") not in self.server.allowed_origins:
            self._send(403, {"error": "origin not allowed"})
        else:
            self._send(204)

    def do_POST(self):
        if not self._allowed():
            return
        try:
            data = self._body()
            path = urlparse(self.path).path
            if path == "/api/v1/ssh/probe":
                self._send(200, probe(data.get("host"), data.get("port", 22)))
            elif path == "/api/v1/ssh/sessions":
                interval = data.get("interval_seconds", 30)
                if not isinstance(interval, int) or isinstance(interval, bool) or not 5 <= interval <= 3600:
                    raise ValueError("interval_seconds must be 5..3600")
                purge_sessions(self.server)
                with self.server.sessions_lock:
                    if len(self.server.sessions) >= self.server.max_sessions:
                        raise ValueError("session limit reached")
                transport = connect(data.get("host"), data.get("port", 22), data.get("username"), data.get("password"), data.get("fingerprint"))
                session = SSHSession(transport, interval)
                session_id = uuid.uuid4().hex
                with self.server.sessions_lock:
                    self.server.sessions[session_id] = session
                session.start()
                self._send(201, {"session_id": session_id})
            else:
                self._send(404, {"error": "not found"})
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._send(400, {"error": str(error)})
        except (OSError, EOFError, paramiko.SSHException):
            self._send(502, {"error": "SSH connection or authentication failed"})

    def _session(self):
        parts = urlparse(self.path).path.split("/")
        if len(parts) != 7 or parts[:5] != ["", "api", "v1", "ssh", "sessions"] or parts[6] != "history":
            return None, None
        session_id = parts[5]
        purge_sessions(self.server)
        with self.server.sessions_lock:
            return session_id, self.server.sessions.get(session_id)

    def do_GET(self):
        if not self._allowed():
            return
        session_id, session = self._session()
        if not session:
            self._send(404, {"error": "session not found; reconnect required"})
            return
        try:
            minutes = int(parse_qs(urlparse(self.path).query).get("minutes", ["30"])[0])
            if not 1 <= minutes <= 1440:
                raise ValueError()
        except ValueError:
            self._send(400, {"error": "minutes must be 1..1440"})
            return
        self._send(200, session.history(minutes))

    def do_DELETE(self):
        if not self._allowed():
            return
        parts = urlparse(self.path).path.split("/")
        if len(parts) != 6 or parts[:5] != ["", "api", "v1", "ssh", "sessions"]:
            self._send(404, {"error": "not found"})
            return
        with self.server.sessions_lock:
            session = self.server.sessions.pop(parts[5], None)
        if session:
            session.close()
        self._send(200, {"closed": bool(session)})

    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args), flush=True)


def main():
    token = os.environ.get("SB_GATEWAY_TOKEN", "")
    if len(token) < 24:
        raise SystemExit("SB_GATEWAY_TOKEN must be a random token of at least 24 characters")
    host = os.environ.get("SB_GATEWAY_HOST", "127.0.0.1")
    port = int(os.environ.get("SB_GATEWAY_PORT", "8766"))
    cert, key = os.environ.get("SB_GATEWAY_TLS_CERT"), os.environ.get("SB_GATEWAY_TLS_KEY")
    if bool(cert) != bool(key):
        raise SystemExit("SB_GATEWAY_TLS_CERT and SB_GATEWAY_TLS_KEY must be set together")
    if not ipaddress.ip_address(socket.gethostbyname(host)).is_loopback and not cert:
        raise SystemExit("TLS is required when binding beyond loopback")
    server = ThreadingHTTPServer((host, port), Handler)
    server.token = token
    server.sessions = {}
    server.sessions_lock = threading.Lock()
    server.max_sessions = int(os.environ.get("SB_GATEWAY_MAX_SESSIONS", "20"))
    server.allowed_origins = {item.strip().rstrip("/") for item in os.environ.get(
        "SB_ALLOWED_ORIGINS", "https://wushanchi.github.io,http://127.0.0.1:5173"
    ).split(",") if item.strip()}
    if cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"Server Board SSH gateway listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
