import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch

from server_board_agent import Collector, Handler, parse_npu_smi


SAMPLE = """+------------------------------------------------------------------------------------+
| NPU Name           | Health        | Power(W) Temp(C) Hugepages-Usage(page)         |
| Chip Device        | Bus-Id        | AICore(%) Memory-Usage(MB) HBM-Usage(MB)       |
+====================+===============+=================================================+
| 0 910B             | OK            | 155.4  48  0 / 0                                |
| 0 0                | 0000:81:00.0  | 76  0 / 0  24576 / 65536                         |
+--------------------+---------------+-------------------------------------------------+
| 1 910B             | WARNING       | 128.1  43  0 / 0                                |
| 0 1                | 0000:82:00.0  | 22  0 / 0  16384 / 65536                         |
+------------------------------------------------------------------------------------+"""


class ParserTests(unittest.TestCase):
    def test_two_devices(self):
        devices = parse_npu_smi(SAMPLE)
        self.assertEqual(len(devices), 2)
        self.assertEqual(devices[0], {
            "id": "0", "model": "910B", "health": "OK", "power_w": 155.4,
            "temperature_c": 48.0, "utilization": 76.0,
            "hbm_used_mb": 24576.0, "hbm_total_mb": 65536.0,
        })
        self.assertEqual(devices[1]["health"], "WARNING")
        self.assertEqual(devices[1]["utilization"], 22.0)

    def test_unrecognized_output_is_not_a_zero_reading(self):
        self.assertEqual(parse_npu_smi("command failed"), [])
        collector = Collector()
        with patch("server_board_agent.subprocess.run") as run:
            run.return_value.stdout = "command failed"
            collector.collect()
        self.assertEqual(collector.history(30)["samples"], [])
        self.assertIn("did not contain", collector.last_error)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.token = "test-token-12345678901234567890"
        self.server.collector = Collector()
        self.server.retention_minutes = 1440
        self.server.allowed_origins = {"https://wushanchi.github.io"}
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request(method, "/api/v1/history?minutes=30", headers=headers or {})
        response = connection.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        connection.close()
        return result

    def test_authorization_and_origin(self):
        status, _, _ = self.request("GET")
        self.assertEqual(status, 401)
        status, _, _ = self.request("GET", {"Origin": "https://untrusted.example", "Authorization": "Bearer " + self.server.token})
        self.assertEqual(status, 403)
        status, headers, body = self.request("GET", {"Origin": "https://wushanchi.github.io", "Authorization": "Bearer " + self.server.token})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://wushanchi.github.io")
        self.assertIn(b'"samples": []', body)

    def test_private_network_preflight(self):
        status, headers, _ = self.request("OPTIONS", {
            "Origin": "https://wushanchi.github.io",
            "Access-Control-Request-Private-Network": "true",
        })
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")


if __name__ == "__main__":
    unittest.main()
