import {
  createIcons, Activity, Plus, Server, RefreshCw, Settings2, X, Trash2,
  Play, Pause, Cpu, MemoryStick, Thermometer, Zap, CircleAlert, Clock3,
  ChartNoAxesCombined, ShieldCheck, ExternalLink, Check, Info,
} from 'lucide';
import './styles.css';

const icons = { Activity, Plus, Server, RefreshCw, Settings2, X, Trash2, Play, Pause,
  Cpu, MemoryStick, Thermometer, Zap, CircleAlert, Clock3, ChartNoAxesCombined,
  ShieldCheck, ExternalLink, Check, Info };
const STORAGE = 'server-board.servers.v1';
const SETTINGS = 'server-board.settings.v1';
const TOKENS = 'server-board.tokens.v1';
const sshSessions = new Map();
const app = document.querySelector('#app');
const readJson = (store, key, fallback) => {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
};
let servers = readJson(localStorage, STORAGE, []);
let settings = { range: 30, poll: 30, ...readJson(localStorage, SETTINGS, {}) };
let tokens = readJson(sessionStorage, TOKENS, {});
let demo = false;
let paused = false;
let loading = false;
let timer;
let modalOpen = false;
const results = new Map();

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, size = 18) => `<i data-lucide="${name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}" width="${size}" height="${size}" aria-hidden="true"></i>`;
const num = (value, digits = 0) => Number.isFinite(value) ? Number(value).toFixed(digits) : '--';
const pct = value => Number.isFinite(value) ? `${Math.round(value)}%` : '--';
const formatTime = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const age = ts => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
};
function normalizeEndpoint(input) {
  const raw = input.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}:8765`);
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('仅输入 IP、主机名或接口根地址');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('远程接口必须使用 HTTPS');
  }
  return url.origin;
}
function normalizeGateway(input) {
  const raw = input.trim() || 'http://127.0.0.1:8766';
  return normalizeEndpoint(/^https?:\/\//i.test(raw) ? raw : `https://${raw}:8766`);
}
function normalizeHost(input) {
  const host = input.trim();
  if (!host || host.length > 253 || /[\s/\\:@?#]/.test(host)) throw new Error('请输入有效的 SSH 服务器 IP 或主机名');
  return host;
}
async function gatewayRequest(endpoint, token, path, method = 'GET', body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), method === 'POST' ? 30000 : 15000);
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? '网关令牌无效' : data.error || `网关返回 HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('网关连接超时');
    if (error instanceof TypeError) throw new Error('无法连接网关，请检查地址、证书和网络');
    throw error;
  } finally { clearTimeout(timeout); }
}
function save() {
  localStorage.setItem(STORAGE, JSON.stringify(servers));
  localStorage.setItem(SETTINGS, JSON.stringify(settings));
  sessionStorage.setItem(TOKENS, JSON.stringify(tokens));
}
function button(label, action, extra = '') {
  return `<button type="button" ${extra} data-action="${action}">${label}</button>`;
}
function header() {
  return `<aside class="sidebar">
    <div class="brand"><span class="brand-mark">${icon('Activity', 21)}</span><span>SERVER<span class="brand-accent">BOARD</span><small>服务器监控工作台</small></span></div>
    <div class="nav-label">工作空间</div>
    <div class="nav-item active">${icon('ChartNoAxesCombined', 18)}<span>NPU 资源</span><span class="nav-active-mark"></span></div>
    <div class="sidebar-bottom"><span class="side-orbit"></span><span>历史数据仅保留在采样服务内存</span></div>
  </aside>
  <main class="main">
    <div class="topbar"><div class="breadcrumb">工作空间 <span>/</span> <strong>NPU 资源</strong></div><div class="top-right"><span class="today" id="clock"></span><a href="https://github.com/wushanchi/server_board" target="_blank" rel="noopener" title="查看项目仓库">${icon('ExternalLink', 16)}<span>GitHub</span></a></div></div>
    <div class="content"><div class="page-head"><div><div class="eyebrow">RESOURCE MONITORING <span></span> LIVE DASHBOARD</div><h1>NPU 资源面板</h1><p class="subtitle">跨服务器查看设备负载、显存和运行状态</p></div><div class="page-actions">${button(`${icon('RefreshCw', 17)}<span>立即刷新</span>`, 'refresh', `class="btn secondary" ${loading ? 'disabled' : ''}`)}${button(`${icon('Plus', 18)}<span>添加服务器</span>`, 'open-add', 'class="btn primary"')}</div></div>
    <div id="dashboard"></div></div>
  </main>`;
}
function renderStats(items) {
  const active = items.filter(x => x.sample && !x.error && Date.now() - Date.parse(x.sample.timestamp) <= Math.max(90, x.response.interval_seconds * 3) * 1000);
  const devices = active.flatMap(x => x.sample.devices || []);
  const valid = devices.filter(x => Number.isFinite(x.utilization));
  const memory = devices.filter(x => Number.isFinite(x.hbm_used_mb) && Number.isFinite(x.hbm_total_mb) && x.hbm_total_mb > 0);
  const memUsed = memory.reduce((sum, x) => sum + x.hbm_used_mb, 0);
  const memTotal = memory.reduce((sum, x) => sum + x.hbm_total_mb, 0);
  const stats = [
    ['在线服务器', `${active.length}`, `${items.length} 台已添加`, 'Server', 'teal'],
    ['NPU 设备', `${devices.length}`, '当前可见', 'Cpu', 'blue'],
    ['平均算力占用', valid.length ? pct(valid.reduce((sum, x) => sum + x.utilization, 0) / valid.length) : '--', `${valid.length} 个有效读数`, 'Activity', 'coral'],
    ['HBM 占用', memTotal ? pct(memUsed / memTotal * 100) : '--', memTotal ? `${(memUsed / 1024).toFixed(1)} / ${(memTotal / 1024).toFixed(1)} GB` : '暂无读数', 'MemoryStick', 'amber'],
  ];
  return `<div class="stats">${stats.map(([label, value, detail, symbol, tone]) => `<div class="stat"><div class="stat-top"><span>${label}</span><span class="stat-icon ${tone}">${icon(symbol, 19)}</span></div><strong>${value}</strong><small>${detail}</small></div>`).join('')}</div>`;
}
function points(samples, deviceId) {
  return samples.map(s => ({ t: Date.parse(s.timestamp), y: s.devices.find(d => d.id === deviceId)?.utilization })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.y));
}
function sparkline(data, color) {
  if (data.length < 2) return '<div class="spark-empty">暂无趋势</div>';
  const min = data[0].t, span = Math.max(1, data.at(-1).t - min);
  const path = data.map((p, i) => `${i ? 'L' : 'M'}${(p.t - min) / span * 120},${34 - p.y / 100 * 30}`).join(' ');
  return `<svg class="spark" viewBox="0 0 120 38" preserveAspectRatio="none" aria-label="算力使用趋势"><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function timeline(samples, devices) {
  const all = devices.map((d, i) => ({ id: d.id, color: ['#159788', '#dd714f', '#4384c5', '#d0a044', '#876ab1', '#56a2a6'][i % 6], data: points(samples, d.id) }));
  const valid = all.flatMap(x => x.data);
  if (valid.length < 2) return '<div class="timeline-empty">等待更多采样数据</div>';
  const t0 = Math.min(...valid.map(p => p.t)), t1 = Math.max(...valid.map(p => p.t));
  const x = t => 42 + (t - t0) / Math.max(1, t1 - t0) * 704;
  const y = value => 140 - value * 1.1;
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 760 166" role="img" aria-label="NPU 算力占用趋势">
    ${[0, 50, 100].map(v => `<line x1="42" x2="746" y1="${y(v)}" y2="${y(v)}" class="grid-line"/><text x="0" y="${y(v) + 4}" class="axis-label">${v}%</text>`).join('')}
    ${all.map(series => `<path d="${series.data.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${series.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
  </svg><div class="chart-times"><span>${formatTime(t0)}</span><span>${formatTime(t1)}</span></div></div>
  <div class="legend">${all.map(s => `<span><i style="background:${s.color}"></i>NPU ${escapeHtml(s.id)}</span>`).join('')}</div>`;
}
function deviceCard(device, samples, index) {
  const color = ['#159788', '#dd714f', '#4384c5', '#d0a044', '#876ab1', '#56a2a6'][index % 6];
  const util = Number.isFinite(device.utilization) ? Math.max(0, Math.min(100, device.utilization)) : 0;
  const memory = device.hbm_total_mb > 0 ? device.hbm_used_mb / device.hbm_total_mb * 100 : null;
  return `<div class="device-card"><div class="device-top"><span class="device-id"><span class="device-dot" style="background:${color}"></span>NPU ${escapeHtml(device.id)}</span><span class="health ${device.health === 'OK' ? 'ok' : 'warn'}">${escapeHtml(device.health || '未知')}</span></div>
    <div class="device-model">${escapeHtml(device.model || 'Ascend NPU')}</div><div class="device-main"><div><span class="metric-label">AI Core</span><div class="device-value">${pct(device.utilization)}</div></div>${sparkline(points(samples, device.id), color)}</div>
    <div class="usage"><span style="width:${util}%;background:${color}"></span></div>
    <div class="device-bottom"><div>${icon('MemoryStick', 15)}<span>HBM</span><strong>${pct(memory)}</strong></div><div>${icon('Thermometer', 15)}<span>温度</span><strong>${Number.isFinite(device.temperature_c) ? `${num(device.temperature_c)}°C` : '--'}</strong></div><div>${icon('Zap', 15)}<span>功耗</span><strong>${Number.isFinite(device.power_w) ? `${num(device.power_w)} W` : '--'}</strong></div></div>
  </div>`;
}
function renderServer(item) {
  const { server, response, sample, error } = item;
  const devices = sample?.devices || [];
  const samples = response?.samples || [];
  const stale = sample && Date.now() - Date.parse(sample.timestamp) > Math.max(90, response.interval_seconds * 3) * 1000;
  const state = error ? 'error' : stale ? 'warn' : sample ? 'online' : 'pending';
  const stateText = error ? '连接失败' : stale ? '数据延迟' : sample ? '运行中' : '等待采样';
  return `<section class="server-section"><div class="section-head"><div class="section-heading"><span class="server-symbol">${icon('Server', 19)}</span><div><div class="server-title"><h2>${escapeHtml(server.name)}</h2><span class="status ${state}"><i></i>${stateText}</span></div><p>${escapeHtml(server.mode === 'ssh' ? `SSH ${server.host}:${server.port}` : server.endpoint.replace(/^https?:\/\//, ''))}${sample ? ` <span>· 更新于 ${age(sample.timestamp)}</span>` : ''}</p></div></div><div class="section-tools">${button(icon('RefreshCw', 17), `refresh:${server.id}`, `class="icon-btn" title="刷新 ${escapeHtml(server.name)}" aria-label="刷新 ${escapeHtml(server.name)}"`)}${button(icon('Trash2', 17), `remove:${server.id}`, `class="icon-btn" title="移除 ${escapeHtml(server.name)}" aria-label="移除 ${escapeHtml(server.name)}"`)}</div></div>
    ${error ? `<div class="error-line">${icon('CircleAlert', 17)}<span>${escapeHtml(error)}</span>${server.mode === 'ssh' ? button('重新登录', `token:${server.id}`, 'class="text-button"') : !tokens[server.id] ? button('设置令牌', `token:${server.id}`, 'class="text-button"') : ''}</div>` : ''}
    ${devices.length ? `<div class="device-grid">${devices.map((d, i) => deviceCard(d, samples, i)).join('')}</div><div class="trend-head"><div><h3>算力占用趋势</h3><span>AI Core 使用率</span></div><span>${samples.length} 个采样点</span></div>${timeline(samples, devices)}` : !error ? '<div class="server-pending">等待采集端返回 NPU 数据</div>' : ''}
  </section>`;
}
function demoResults() {
  const configs = [{ id: 'demo-1', name: '训练节点 A', endpoint: 'demo-a.local', count: 4 }, { id: 'demo-2', name: '推理节点 B', endpoint: 'demo-b.local', count: 2 }];
  const step = settings.range <= 60 ? 30 : settings.range <= 360 ? 120 : 600;
  const count = settings.range * 60 / step;
  return configs.map((server, si) => {
    const samples = Array.from({ length: count + 1 }, (_, i) => {
      const timestamp = new Date(Date.now() - (count - i) * step * 1000).toISOString();
      const devices = Array.from({ length: server.count }, (_, di) => {
        const base = si ? 28 : 51;
        const utilization = Math.max(3, Math.min(96, Math.round(base + 24 * Math.sin(i / 12 + di * 0.8) + 9 * Math.sin(i / 3.9 + di * 2))));
        return { id: `${di}`, model: 'Ascend 910B', health: 'OK', utilization, hbm_used_mb: 18000 + di * 2400 + utilization * 110, hbm_total_mb: 65536, temperature_c: 42 + Math.round(utilization * 0.21), power_w: 125 + Math.round(utilization * 1.8) };
      });
      return { timestamp, devices };
    });
    return { server, response: { interval_seconds: step, samples }, sample: samples.at(-1) };
  });
}
function renderDashboard() {
  const items = demo ? demoResults() : servers.map(server => {
    const result = results.get(server.id) || {};
    return { server, ...result, sample: result.response?.samples?.at(-1) };
  });
  const ranges = [[15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [360, '6 小时'], [1440, '24 小时']];
  const polls = [[15, '15 秒'], [30, '30 秒'], [60, '1 分钟'], [120, '2 分钟']];
  document.querySelector('#dashboard').innerHTML = `${demo ? `<div class="demo-banner">${icon('Info', 17)}<strong>演示模式</strong><span>当前显示模拟数据</span>${button('退出演示', 'demo-off', 'class="text-button"')}</div>` : ''}
    ${renderStats(items)}<div class="controls"><div class="control-group"><span class="control-label">时间范围</span><div class="segmented">${ranges.map(([v, label]) => button(label, `range:${v}`, `class="${settings.range === v ? 'selected' : ''}" aria-pressed="${settings.range === v}"`)).join('')}</div></div><div class="control-group right"><label class="control-label" for="poll">${icon('Clock3', 15)}页面刷新</label><select id="poll" aria-label="刷新间隔">${polls.map(([v, label]) => `<option value="${v}" ${settings.poll === v ? 'selected' : ''}>${label}</option>`).join('')}</select>${button(icon(paused ? 'Play' : 'Pause', 16), 'pause', `class="icon-btn pause-btn" title="${paused ? '继续自动刷新' : '暂停自动刷新'}" aria-label="${paused ? '继续自动刷新' : '暂停自动刷新'}"`)}</div></div>
    ${items.length ? `<div class="servers">${items.map(renderServer).join('')}</div>` : `<div class="empty"><span class="empty-art">${icon('Server', 34)}</span><h2>尚未连接服务器</h2><p>添加服务器，开始查看 NPU 资源。</p><div>${button(`${icon('Plus', 17)}添加服务器`, 'open-add', 'class="btn primary"')}${button('查看演示', 'demo-on', 'class="btn secondary"')}</div></div>`}
    <footer><span>SERVER BOARD</span><span>历史数据仅保留在采样服务内存</span></footer>`;
  document.querySelector('#poll').addEventListener('change', event => { settings.poll = Number(event.target.value); save(); restartTimer(); renderDashboard(); });
  createIcons({ icons });
}
function renderModal(serverId = null, requestedMode = null, probeResult = null, initial = {}) {
  closeModal();
  const server = servers.find(x => x.id === serverId);
  const mode = requestedMode || server?.mode || 'agent';
  const isToken = Boolean(server) && mode === 'agent';
  const value = (key, fallback = '') => escapeHtml(initial[key] ?? server?.[key] ?? fallback);
  const modes = !server ? `<div class="connection-modes">${button('HTTPS 采集端', 'mode:agent', `class="${mode === 'agent' ? 'current' : ''}" aria-pressed="${mode === 'agent'}"`)}${button('SSH 登录', 'mode:ssh', `class="${mode === 'ssh' ? 'current' : ''}" aria-pressed="${mode === 'ssh'}"`)}</div>` : '';
  const sshFields = `<label for="server-name">显示名称</label><input id="server-name" name="name" value="${value('name')}" placeholder="例如：训练节点 A" maxlength="60" required />
    <div class="field-row"><div><label for="ssh-host">服务器 IP / 主机名</label><input id="ssh-host" name="host" value="${value('host')}" placeholder="192.168.1.10" spellcheck="false" ${probeResult ? 'readonly' : ''} required /></div><div><label for="ssh-port">SSH 端口</label><input id="ssh-port" name="port" type="number" min="1" max="65535" value="${value('port', 22)}" ${probeResult ? 'readonly' : ''} required /></div></div>
    <label for="ssh-username">SSH 用户名</label><input id="ssh-username" name="username" value="${value('username')}" autocomplete="username" required />
    <label for="gateway-endpoint">SSH 网关地址</label><input id="gateway-endpoint" name="gateway" value="${value('gateway', 'http://127.0.0.1:8766')}" spellcheck="false" ${probeResult ? 'readonly' : ''} required />
    <label for="gateway-token">网关访问令牌</label><input id="gateway-token" name="token" type="password" value="${escapeHtml(initial.token ?? tokens[serverId] ?? '')}" autocomplete="off" required />
    <label for="sample-interval">采样间隔</label><select id="sample-interval" name="interval"><option value="15" ${value('interval', 30) === '15' ? 'selected' : ''}>15 秒</option><option value="30" ${value('interval', 30) === '30' ? 'selected' : ''}>30 秒</option><option value="60" ${value('interval', 30) === '60' ? 'selected' : ''}>60 秒</option><option value="120" ${value('interval', 30) === '120' ? 'selected' : ''}>120 秒</option></select>
    ${probeResult ? `<div class="fingerprint"><span>服务器主机指纹 (${escapeHtml(probeResult.algorithm)})</span><code>${escapeHtml(probeResult.fingerprint)}</code></div><label class="confirm-fingerprint"><input type="checkbox" name="confirmed" required />我已核对并信任此服务器的主机指纹</label><label for="ssh-password">SSH 密码</label><input id="ssh-password" name="password" type="password" autocomplete="new-password" required /><small>密码只用于本次连接，不会保存到浏览器或仓库。</small>` : '<small>先读取并核对服务器主机指纹，再输入密码。</small>'}`;
  const agentFields = `${!isToken ? `<label for="server-name">显示名称</label><input id="server-name" name="name" placeholder="例如：训练节点 A" maxlength="60" required /><label for="server-endpoint">服务器 IP 或 HTTPS 地址</label><input id="server-endpoint" name="endpoint" placeholder="192.168.1.10 或 https://npu.example.com" spellcheck="false" required /><small>直接输入 IP 时默认连接 HTTPS 8765 端口。</small>` : `<p class="token-server">${escapeHtml(server.name)}</p>`}<label for="server-token">访问令牌</label><input id="server-token" name="token" type="password" placeholder="采集端配置的令牌" autocomplete="off" required /><small>令牌仅保留在当前浏览器标签页。</small>`;
  modalOpen = true;
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><span class="modal-eyebrow">SERVER CONNECTION</span><h2 id="modal-title">${server ? mode === 'ssh' ? '重新登录 SSH' : '更新访问令牌' : '添加服务器'}</h2></div>${button(icon('X', 19), 'close-modal', 'class="icon-btn" aria-label="关闭"')}</div><form id="server-form"><div class="modal-body">${modes}${mode === 'ssh' ? sshFields : agentFields}<div id="form-error" class="form-error" role="alert"></div></div><div class="modal-foot">${button('取消', 'close-modal', 'class="btn secondary"')}${mode === 'ssh' && !probeResult ? button('读取主机指纹', 'probe-ssh', 'class="btn primary"') : `<button type="submit" class="btn primary">${isToken ? '保存令牌' : mode === 'ssh' ? 'SSH 登录' : '连接服务器'}</button>`}</div></form></div></div>`);
  const form = document.querySelector('#server-form');
  const showError = error => { document.querySelector('#form-error').textContent = error.message; };
  form.addEventListener('click', async event => {
    if (event.target.closest('[data-action="probe-ssh"]') !== null) {
      if (!form.reportValidity()) return;
      const button = event.target.closest('button');
      button.disabled = true;
      try {
        const data = new FormData(form);
        const host = normalizeHost(String(data.get('host')));
        const port = Number(data.get('port'));
        const gateway = normalizeGateway(String(data.get('gateway')));
        const token = String(data.get('token')).trim();
        const result = await gatewayRequest(gateway, token, '/api/v1/ssh/probe', 'POST', { host, port });
        renderModal(serverId, 'ssh', result, { name: data.get('name'), host, port, username: data.get('username'), gateway, token, interval: data.get('interval') });
      } catch (error) { showError(error); button.disabled = false; }
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const data = new FormData(form);
      if (mode === 'ssh') {
        if (!probeResult || data.get('confirmed') !== 'on') throw new Error('请先确认服务器主机指纹');
        const host = normalizeHost(String(data.get('host')));
        const port = Number(data.get('port'));
        const gateway = normalizeGateway(String(data.get('gateway')));
        const token = String(data.get('token')).trim();
        if (servers.some(s => s.id !== serverId && s.mode === 'ssh' && s.host === host && s.port === port && s.gateway === gateway)) throw new Error('这台 SSH 服务器已经添加');
        const response = await gatewayRequest(gateway, token, '/api/v1/ssh/sessions', 'POST', {
          host, port, username: String(data.get('username')).trim(), password: String(data.get('password')),
          fingerprint: probeResult.fingerprint, interval_seconds: Number(data.get('interval')),
        });
        const id = serverId || crypto.randomUUID();
        if (serverId && sshSessions.has(id)) closeSSHSession(server);
        const config = { id, mode: 'ssh', name: String(data.get('name')).trim(), host, port, username: String(data.get('username')).trim(), gateway, interval: Number(data.get('interval')) };
        if (server) Object.assign(server, config); else servers.push(config);
        tokens[id] = token;
        sshSessions.set(id, response.session_id);
      } else if (isToken) tokens[server.id] = String(data.get('token')).trim();
      else {
        const endpoint = normalizeEndpoint(String(data.get('endpoint')));
        if (servers.some(s => s.endpoint === endpoint)) throw new Error('这台服务器已经添加');
        const id = crypto.randomUUID();
        servers.push({ id, name: String(data.get('name')).trim(), endpoint });
        tokens[id] = String(data.get('token')).trim();
      }
      save(); closeModal(); renderDashboard(); refreshAll();
    } catch (error) { showError(error); submit.disabled = false; }
  });
  form.querySelector('input')?.focus();
  createIcons({ icons });
}
function closeModal() { document.querySelector('#modal')?.remove(); modalOpen = false; }
function closeSSHSession(server) {
  const sessionId = sshSessions.get(server.id);
  sshSessions.delete(server.id);
  if (sessionId && tokens[server.id]) gatewayRequest(server.gateway, tokens[server.id], `/api/v1/ssh/sessions/${sessionId}`, 'DELETE').catch(() => {});
}
async function refreshServer(server) {
  const token = tokens[server.id];
  if (server.mode === 'ssh' && !sshSessions.has(server.id)) {
    results.set(server.id, { error: 'SSH 会话未连接，请重新登录。' }); return;
  }
  if (!token) { results.set(server.id, { error: '访问令牌未设置，请重新填写。' }); return; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let data;
    if (server.mode === 'ssh') {
      data = await gatewayRequest(server.gateway, token, `/api/v1/ssh/sessions/${sshSessions.get(server.id)}/history?minutes=${settings.range}`);
    } else {
      const response = await fetch(`${server.endpoint}/api/v1/history?minutes=${settings.range}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal });
      if (response.status === 401) throw new Error('访问令牌无效');
      if (!response.ok) throw new Error(`接口返回 HTTP ${response.status}`);
      data = await response.json();
    }
    if (!Array.isArray(data.samples)) throw new Error('采集端返回了无效数据');
    results.set(server.id, { response: data, error: data.last_error ? `采集失败：${data.last_error}` : null });
  } catch (error) {
    if (server.mode === 'ssh' && error.message.includes('reconnect required')) sshSessions.delete(server.id);
    results.set(server.id, { ...results.get(server.id), error: error.name === 'AbortError' ? '连接超时，请检查地址和网络' : error instanceof TypeError ? '无法连接。请检查 HTTPS 证书、CORS 和服务器网络。' : error.message });
  } finally { clearTimeout(timeout); }
}
async function refreshAll() {
  if (loading || demo || !servers.length) return;
  loading = true;
  await Promise.all(servers.map(refreshServer));
  loading = false;
  renderDashboard();
}
function restartTimer() {
  clearInterval(timer);
  if (!paused) timer = setInterval(refreshAll, settings.poll * 1000);
}
function handleAction(action) {
  if (action === 'open-add') renderModal();
  else if (action === 'close-modal') closeModal();
  else if (action === 'refresh') refreshAll();
  else if (action === 'demo-on' || action === 'demo-off') { demo = action === 'demo-on'; renderDashboard(); if (!demo) refreshAll(); }
  else if (action === 'pause') { paused = !paused; restartTimer(); renderDashboard(); }
  else if (action.startsWith('range:')) { settings.range = Number(action.split(':')[1]); save(); renderDashboard(); if (!demo) refreshAll(); }
  else if (action.startsWith('refresh:')) { const server = servers.find(s => s.id === action.slice(8)); if (server) refreshServer(server).then(renderDashboard); }
  else if (action.startsWith('token:')) renderModal(action.slice(6));
  else if (action.startsWith('mode:')) renderModal(null, action.slice(5));
  else if (action.startsWith('remove:')) { const id = action.slice(7); const server = servers.find(s => s.id === id); if (server?.mode === 'ssh') closeSSHSession(server); servers = servers.filter(s => s.id !== id); delete tokens[id]; results.delete(id); save(); renderDashboard(); }
}
app.innerHTML = header();
document.addEventListener('click', event => {
  if (modalOpen && event.target.id === 'modal') closeModal();
  const target = event.target.closest('[data-action]');
  if (target && target.dataset.action !== 'probe-ssh') handleAction(target.dataset.action);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && modalOpen) closeModal(); });
setInterval(() => { const clock = document.querySelector('#clock'); if (clock) clock.textContent = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' }); }, 1000);
renderDashboard();
restartTimer();
refreshAll();
