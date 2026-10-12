# Server Board

面向多台 Ascend 服务器的 NPU 资源面板。网页可在 [wushanchi.github.io/server_board/](https://wushanchi.github.io/server_board/) 打开；采集端在每台服务器上定时运行 `npu-smi info`，通过只读 HTTPS 接口提供最近的历史数据。

## 功能

- 同屏展示多台服务器及其 NPU 设备、AI Core 占用率、HBM、温度、功耗和健康状态。
- 时间窗口可选 15 分钟、30 分钟、1 小时、6 小时、24 小时；网页刷新周期可选 15、30、60、120 秒，默认 30 秒。
- 采集端默认每 30 秒采样一次，内存中保留 24 小时；`SB_INTERVAL` 和 `SB_RETENTION_MINUTES` 可调整。
- 服务地址和显示名称保存在浏览器本地；访问令牌仅保存在当前标签页的 `sessionStorage`。服务器数据不会上传到 GitHub。
- “查看演示”仅显示明确标注的模拟数据，不代表真实 NPU 状态。
- 已预留 SSH 登录接入位置。后续可通过受控网关使用 IP、用户名和密码连接；当前版本不会在纯静态网页中收集或保存 SSH 密码。

## 架构与前提

GitHub Pages 只托管静态网页，浏览器不能直接 SSH 到服务器。每台 NPU 服务器需要运行 `agent/server_board_agent.py`，并提供浏览器可访问、证书受信任的 HTTPS 地址。网页输入 IP 时默认连接 `https://IP:8765`；也可输入完整的 HTTPS 地址。浏览器和服务器之间必须网络可达。访问内网 IP 时，浏览器可能会请求本地网络访问权限。

```text
浏览器 / GitHub Pages
       │ HTTPS + Bearer token
       ├── NPU server A: agent -> npu-smi info -> 24h in-memory history
       └── NPU server B: agent -> npu-smi info -> 24h in-memory history
```

### 1. 启动采集端

采集端仅依赖 Python 3.9+ 标准库和服务器上的 `npu-smi`。先在服务器验证 `npu-smi info` 有可解析的设备表。为每台服务器生成不同的高强度令牌，在服务环境中设置：

```bash
export SB_TOKEN="$(openssl rand -hex 32)"
export SB_HOST=127.0.0.1
export SB_PORT=8765
export SB_INTERVAL=30
export SB_RETENTION_MINUTES=1440
export SB_ALLOWED_ORIGINS=https://wushanchi.github.io
python3 agent/server_board_agent.py
```

把生成的 `SB_TOKEN` 存入自己的密码管理器，之后在网页添加服务器时填写同一令牌。不要把令牌写入代码、提交记录或公开日志。

生产环境建议让采集端只监听 `127.0.0.1`，由已有反向代理终止 HTTPS，并限制可访问来源。例如 Caddy：

```caddyfile
npu-a.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

域名需指向该服务器，并由 Caddy 获取公开受信任的证书。若必须使用裸 IP，需提供包含该 IP 的、浏览器受信任的 TLS 证书，然后设置 `SB_HOST=0.0.0.0`、`SB_TLS_CERT` 和 `SB_TLS_KEY`。采集端禁止在非本机地址上无 TLS 启动。不要将令牌写入仓库，也不要向公网开放未受保护的反向代理路径。

注意：令牌通过 HTTPS 发送到**你填写的服务器地址**。只填写自己控制的采集端地址。采集端限制 `Origin`，并使用常量时间比较校验令牌；它不会在 HTTP 响应中返回令牌。

### 2. 网页连接

打开网页，点击“添加服务器”，填写名称、服务器 IP 或 HTTPS 根地址以及对应令牌。一个浏览器标签页可添加多台服务器。刷新或重新打开标签页后，服务列表保留；新标签页需要重新输入令牌。移除服务器会删除本地保存的地址和该标签页的令牌。

若出现连接错误，依次检查浏览器到采集端的网络、TLS 证书、`SB_ALLOWED_ORIGINS`、令牌，以及服务器上 `npu-smi info` 的输出。页面会把采集失败与网络失败分开显示。采集端进程重启后，内存历史会重新开始积累。

## 本地开发和验证

```bash
npm install
npm run dev
npm run build
python3 -m unittest discover -s agent -p 'test_*.py'
```

网页默认位于 `http://127.0.0.1:5173/server_board/`。本地调试时可用仅监听 loopback 的 HTTP 采集端，网页允许 `http://127.0.0.1:8765`。若 Vite 改用其他端口，需同步调整 `SB_ALLOWED_ORIGINS`。

## 部署

源码和 Pages 发布文件均在 [`wushanchi/server_board`](https://github.com/wushanchi/server_board)。运行 `npm run build` 后，`docs/` 是可部署的静态站点；GitHub Pages 从 `main` 的 `/docs` 发布，访问路径为 `/server_board/`。账号根站点 `wushanchi.github.io` 仅跳转到此路径。

## 数据接口

`GET /api/v1/history?minutes=30`，请求头 `Authorization: Bearer <token>`。返回格式：

```json
{
  "interval_seconds": 30,
  "last_error": null,
  "samples": [{
    "timestamp": "2026-10-12T12:00:00+00:00",
    "devices": [{
      "id": "0", "model": "910B", "health": "OK",
      "utilization": 76.0, "hbm_used_mb": 24576.0,
      "hbm_total_mb": 65536.0, "temperature_c": 48.0,
      "power_w": 155.4
    }]
  }]
}
```

解析器针对常见的双行 `npu-smi info` 表格。不同 CANN/驱动版本的字段可能变化，接入前请用实际服务器输出核对。缺失指标显示为 `--`，解析失败会返回 `last_error`，不会伪装成 0% 占用。
