import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import ssh_gateway
from ssh_gateway import Handler, SSHSession, connect, fingerprint


SAMPLE = """| 0 910B | OK | 155.4 48 0 / 0 |
| 0 0 | 0000:81:00.0 | 76 0 / 0 24576 / 65536 |"""


class ConnectionTests(unittest.TestCase):
    def test_fingerprint_checked_before_password(self):
        transport = MagicMock()
        transport.get_remote_server_key.return_value.asbytes.return_value = b"server-key"
        with patch("ssh_gateway.open_transport", return_value=transport):
            with self.assertRaisesRegex(ValueError, "fingerprint changed"):
                connect("192.0.2.1", 22, "alice", "secret", "SHA256:wrong")
        transport.auth_password.assert_not_called()
        transport.close.assert_called_once()

    def test_matching_fingerprint_authenticates(self):
        transport = MagicMock()
        transport.get_remote_server_key.return_value.asbytes.return_value = b"server-key"
        transport.is_authenticated.return_value = True
        expected = fingerprint(transport.get_remote_server_key.return_value)
        with patch("ssh_gateway.open_transport", return_value=transport):
            self.assertIs(connect("192.0.2.1", 22, "alice", "secret", expected), transport)
        transport.auth_password.assert_called_once_with("alice", "secret", fallback=False)

    def test_remote_sample_and_parse_error(self):
        transport = MagicMock()
        channel = transport.open_session.return_value
        channel.makefile.return_value.read.return_value = SAMPLE.encode()
        channel.recv_exit_status.return_value = 0
        session = SSHSession(transport, 30)
        session.collect()
        history = session.history(30)
        self.assertEqual(history["samples"][0]["devices"][0]["utilization"], 76.0)
        channel.exec_command.assert_called_once_with("npu-smi info")
        channel.makefile.return_value.read.return_value = b"unknown format"
        session.collect()
        self.assertEqual(len(session.history(30)["samples"]), 1)
        self.assertIn("did not contain", session.last_error)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.token = "test-token-12345678901234567890"
        self.server.allowed_origins = {"https://wushanchi.github.io"}
        self.server.sessions = {}
        self.server.sessions_lock = threading.Lock()
        self.server.max_sessions = 20
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port)
        payload = json.dumps(body) if body is not None else None
        connection.request(method, path, body=payload, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def auth(self):
        return {"Authorization": "Bearer " + self.server.token, "Origin": "https://wushanchi.github.io"}

    def test_authorization_cors_and_probe(self):
        path = "/api/v1/ssh/probe"
        self.assertEqual(self.request("POST", path, {"host": "192.0.2.1"})[0], 401)
        bad = {**self.auth(), "Origin": "https://untrusted.example"}
        self.assertEqual(self.request("POST", path, {"host": "192.0.2.1"}, bad)[0], 403)
        with patch("ssh_gateway.probe", return_value={"fingerprint": "SHA256:test", "algorithm": "ssh-ed25519"}):
            status, headers, body = self.request("POST", path, {"host": "192.0.2.1", "port": 22}, self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://wushanchi.github.io")
        self.assertEqual(json.loads(body)["fingerprint"], "SHA256:test")
        status, headers, _ = self.request("OPTIONS", path, headers={"Origin": "https://wushanchi.github.io", "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")

    def test_session_history_and_delete(self):
        transport = MagicMock()
        with patch("ssh_gateway.connect", return_value=transport), patch.object(SSHSession, "start"):
            status, _, body = self.request("POST", "/api/v1/ssh/sessions", {
                "host": "192.0.2.1", "port": 22, "username": "alice", "password": "secret",
                "fingerprint": "SHA256:test", "interval_seconds": 30,
            }, self.auth())
        self.assertEqual(status, 201)
        session_id = json.loads(body)["session_id"]
        self.assertEqual(self.request("GET", f"/api/v1/ssh/sessions/{session_id}/history?minutes=30", headers=self.auth())[0], 200)
        self.assertEqual(self.request("DELETE", f"/api/v1/ssh/sessions/{session_id}", headers=self.auth())[0], 200)
        transport.close.assert_called()
        self.assertEqual(self.request("GET", f"/api/v1/ssh/sessions/{session_id}/history", headers=self.auth())[0], 404)


if __name__ == "__main__":
    unittest.main()
