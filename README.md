# Server Board

面向多台 Ascend 服务器的 NPU 资源面板。网页位于 [wushanchi.github.io/server_board/](https://wushanchi.github.io/server_board/)。可使用服务器上的 HTTPS 采集端，或在浏览器所在电脑启动 SSH 网关，通过服务器 IP、用户名和密码连接。

## 功能

- 同屏展示多台服务器及其 NPU 设备、AI Core 占用率、HBM、温度、功耗和健康状态。
- 时间窗口可选 15 分钟、30 分钟、1 小时、6 小时、24 小时；网页刷新周期可选 15、30、60、120 秒，默认 30 秒。
- 采集端和 SSH 网关默认每 30 秒采样一次；SSH 登录时可选 15、30、60、120 秒。历史数据在进程内存中保留最多 24 小时。
- 服务地址、显示名称与 SSH 用户名保存在浏览器本地；访问令牌仅保存在当前标签页的 `sessionStorage`。SSH 密码不会保存；刷新网页后需重新登录 SSH。服务器数据不会上传到 GitHub。
- “查看演示”仅显示明确标注的模拟数据，不代表真实 NPU 状态。
- SSH 登录先读取主机公钥指纹，经用户核对确认后才发送密码；建立会话时网关再次比对指纹。

## 架构与前提

GitHub Pages 只托管静态网页，浏览器不能直接 SSH 到服务器。SSH 方式需要在可访问目标服务器的电脑上运行 `agent/ssh_gateway.py`；这台电脑也须能被浏览器访问。网关默认只监听 `127.0.0.1:8766`，适合在当前浏览器所在电脑启动。浏览器可能请求本地网络访问权限。HTTPS 采集端方式仍可用：每台 NPU 服务器运行 `agent/server_board_agent.py`，并提供浏览器可访问且证书受信任的 HTTPS 地址。

```text
浏览器 / GitHub Pages
       │ HTTPS + Bearer token
       ├── NPU server A: agent -> npu-smi info -> 24h in-memory history
       └── SSH gateway -> SSH to server B/C -> npu-smi info -> 24h in-memory history
```

### 1. 启动 SSH 网关

在浏览器所在电脑安装 Python 3.9+ 及依赖，并生成随机网关令牌。Windows PowerShell 示例：

```powershell
python -m pip install -r agent/requirements.txt
$env:SB_GATEWAY_TOKEN = -join ((1..48) | ForEach-Object { 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(Get-Random -Maximum 62)] })
$env:SB_GATEWAY_HOST = '127.0.0.1'
$env:SB_GATEWAY_PORT = '8766'
python agent/ssh_gateway.py
```

将网关令牌保存在自己的密码管理器中。打开网页，点击“添加服务器”并选择“SSH 登录”，填写服务器 IP、SSH 端口、用户名、网关地址及令牌；先读取并核对服务器指纹，再输入 SSH 密码。服务器需要允许密码认证，且登录账号能执行 `npu-smi info`。网关只执行该固定命令，不提供任意命令执行接口。网关令牌可被持有者用来连接它能访问的 SSH 目标，请勿公开。

网关在内存中保持已认证 SSH 会话与采样历史；移除服务器会关闭会话，无访问活动一小时后也会自动关闭。网关进程重启会清空历史和会话。多个浏览器标签页各自需要登录。不要把网关令牌或 SSH 密码写入仓库。远程部署网关时，必须提供可信 HTTPS 证书并设置 `SB_GATEWAY_HOST`、`SB_GATEWAY_TLS_CERT`、`SB_GATEWAY_TLS_KEY`；非本机监听不允许明文 HTTP。可通过 `SB_ALLOWED_ORIGINS` 指定允许访问网关的网页来源，默认包含正式站点和本地开发地址。

### 2. 启动 HTTPS 采集端（可选）

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

### 3. 网页连接

打开网页，点击“添加服务器”，选择 HTTPS 采集端或 SSH 登录。一个浏览器标签页可添加多台服务器。刷新或重新打开标签页后，服务列表保留；新标签页需要重新输入令牌，SSH 服务器还需要重新登录。移除服务器会删除本地保存的地址和该标签页的令牌。

若出现连接错误，依次检查浏览器到采集端的网络、TLS 证书、`SB_ALLOWED_ORIGINS`、令牌，以及服务器上 `npu-smi info` 的输出。页面会把采集失败与网络失败分开显示。采集端进程重启后，内存历史会重新开始积累。

## 本地开发和验证

```bash
npm install
npm run dev
npm run build
python -m pip install -r agent/requirements.txt
python3 -m unittest discover -s agent -p 'test_*.py'
```

网页默认位于 `http://127.0.0.1:5173/server_board/`。本地调试时可用仅监听 loopback 的 HTTP 采集端，网页允许 `http://127.0.0.1:8765`。若 Vite 改用其他端口，需同步调整 `SB_ALLOWED_ORIGINS`。

## 部署

源码位于 [`wushanchi/server_board`](https://github.com/wushanchi/server_board)。运行 `npm run build` 后，将 `dist/` 中的文件放入 [`wushanchi/wushanchi.github.io`](https://github.com/wushanchi/wushanchi.github.io) 仓库的 `server_board/` 文件夹，由该仓库根目录的 Pages 站点发布。Vite 资源基础路径为 `/server_board/`。`server_board` 仓库自身的 Pages 已停用，避免与根站点争用相同路径。

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
