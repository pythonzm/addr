// 本地/远程后台管理服务：可视化触发地址池重建、添加国家、发布到远端（git push）。
//
// 本机模式（默认）：node tools/admin-server.js
//   → 仅绑定 127.0.0.1:8100，免认证。
// 远程模式（VPS）：ADMIN_PASSWORD='强密码' node tools/admin-server.js
//   → 设置密码后开启登录认证，默认绑定 0.0.0.0:8100（可用 HOST/PORT 覆盖）。
//   → 生产部署强烈建议放在 Nginx/Caddy 的 HTTPS 反代之后（明文 HTTP 会暴露口令）。
// 同一时刻只允许一个任务运行（Overpass 礼仪）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const AUTH_ON = PASSWORD.length > 0;
const HOST = process.env.HOST || (AUTH_ON ? '0.0.0.0' : '127.0.0.1');
const PORT = parseInt(process.env.PORT, 10) || 8100;

let job = null; // 当前/最近一次任务 {name, logs[], status: running|done|failed, started}

// ---------- 认证：会话 + 防爆破 ----------
const SESSION_TTL = 12 * 3600 * 1000;
const sessions = new Map(); // token -> 过期时间戳（滑动续期）
const loginFails = new Map(); // ip -> { n, lockUntil }
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = p => {
  try { return crypto.timingSafeEqual(sha256(p), sha256(PASSWORD)); } catch (e) { return false; }
};

function clientIp(req) {
  // 反代场景取 X-Forwarded-For 首个地址（部署时请确保反代覆盖该头）
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
}

function getCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}

function isAuthed(req) {
  if (!AUTH_ON) return true;
  const token = getCookie(req, 'admin_session');
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  sessions.set(token, Date.now() + SESSION_TTL); // 滑动续期
  return true;
}

function issueSession(req, res) {
  // 惰性清理过期会话
  for (const [tk, exp] of sessions) if (Date.now() > exp) sessions.delete(tk);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${secure}`);
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · 后台管理</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #0B0F19; color: #F3F4F6;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { background: #121A2B; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 32px; width: 320px; }
  h1 { font-size: 1.1rem; margin: 0 0 18px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px;
          border: 1px solid rgba(255,255,255,.12); background: #0B0F19; color: #F3F4F6; font-size: .95rem; }
  button { width: 100%; padding: 10px; border: none; border-radius: 8px; background: #0EA5E9; color: #fff;
           font-size: .95rem; cursor: pointer; }
  button:hover { filter: brightness(1.15); }
  .err { color: #EF4444; font-size: .82rem; min-height: 1.2em; margin-bottom: 8px; }
</style></head>
<body><form class="box" onsubmit="login(event)">
  <h1>后台管理登录</h1>
  <input id="pw" type="password" placeholder="访问密码" autofocus autocomplete="current-password">
  <div class="err" id="err"></div>
  <button>登 录</button>
</form>
<script>
async function login(e) {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }) });
  if (r.ok) { location.reload(); return; }
  const j = await r.json().catch(() => ({}));
  document.getElementById('err').textContent = j.error || ('登录失败 HTTP ' + r.status);
}
</script></body></html>`;

// ---------- 业务 ----------
function loadStatus() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'data.js'), 'utf8');
  const COUNTRIES = new Function(src + '; return COUNTRIES;')();
  return Object.entries(COUNTRIES).map(([code, c]) => {
    let pool = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pool', code + '.json'), 'utf8'));
      pool = { count: j.count, generated: j.generated };
    } catch (e) { /* 无地址池 */ }
    return { code, name: c.name, en: c.en, cities: c.cities.map(x => x[0]), pool };
  });
}

function appendLog(chunk) {
  job.logs.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
  if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
}

function startJob(name, cmd, args, res) {
  if (job && job.status === 'running') return send(res, 409, { error: '已有任务在运行，请等待完成' });
  job = { name, logs: [], status: 'running', started: new Date().toLocaleString() };
  const p = spawn(cmd, args, { cwd: ROOT });
  p.stdout.on('data', appendLog);
  p.stderr.on('data', appendLog);
  p.on('error', e => { appendLog('启动失败: ' + e.message); job.status = 'failed'; });
  p.on('close', code => {
    appendLog(`—— 任务结束（退出码 ${code}）——`);
    job.status = code === 0 ? 'done' : 'failed';
  });
  send(res, 200, { ok: true });
}

// 发布：git add/commit/push，串行执行
function publish(res) {
  if (job && job.status === 'running') return send(res, 409, { error: '已有任务在运行，请等待完成' });
  job = { name: '发布到远端', logs: [], status: 'running', started: new Date().toLocaleString() };
  const steps = [
    ['git', ['add', '-A']],
    ['git', ['commit', '-m', 'chore: 后台管理更新地址池/国家数据']],
    ['git', ['push']],
  ];
  const next = i => {
    if (i >= steps.length) { appendLog('—— 发布完成，GitHub Pages / Vercel 将自动重新部署 ——'); job.status = 'done'; return; }
    const [cmd, args] = steps[i];
    appendLog(`$ ${cmd} ${args.join(' ')}`);
    execFile(cmd, args, { cwd: ROOT }, (err, stdout, stderr) => {
      if (stdout) appendLog(stdout);
      if (stderr) appendLog(stderr);
      if (err && !/nothing to commit|无文件要提交/.test(stdout + stderr)) {
        job.status = 'failed';
        appendLog('失败: ' + err.message);
        return;
      }
      next(i + 1);
    });
  };
  next(0);
  send(res, 200, { ok: true });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---- 登录（无需会话）----
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!AUTH_ON) return send(res, 200, { ok: true });
    const ip = clientIp(req);
    const f = loginFails.get(ip) || { n: 0, lockUntil: 0 };
    if (Date.now() < f.lockUntil) {
      return send(res, 429, { error: `尝试次数过多，请 ${Math.ceil((f.lockUntil - Date.now()) / 60000)} 分钟后再试` });
    }
    const { password } = await readBody(req);
    if (!passwordOk(password)) {
      f.n += 1;
      if (f.n >= MAX_FAILS) { f.n = 0; f.lockUntil = Date.now() + LOCK_MS; }
      loginFails.set(ip, f);
      return send(res, 401, { error: '密码错误' });
    }
    loginFails.delete(ip);
    issueSession(req, res);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(getCookie(req, 'admin_session'));
    res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  // ---- 页面 ----
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTH_ON && !isAuthed(req) ? LOGIN_PAGE : fs.readFileSync(path.join(__dirname, 'admin.html')));
    return;
  }

  // ---- 其余 API 一律要求会话 ----
  if (!isAuthed(req)) return send(res, 401, { error: '未登录或会话已过期' });

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { countries: loadStatus(), auth: AUTH_ON, job: job && { name: job.name, status: job.status, started: job.started } });
  }
  if (req.method === 'GET' && url.pathname === '/api/job') {
    if (!job) return send(res, 200, { job: null });
    const from = parseInt(url.searchParams.get('from'), 10) || 0;
    return send(res, 200, { job: { name: job.name, status: job.status, started: job.started, total: job.logs.length, logs: job.logs.slice(from) } });
  }
  if (req.method === 'POST' && url.pathname === '/api/build-pool') {
    const { codes, all } = await readBody(req);
    const list = Array.isArray(codes) ? codes.filter(c => /^[A-Z]{2}$/.test(c)) : [];
    if (!list.length && all !== true) return send(res, 400, { error: '请指定国家代码，或显式传 all:true 重建全部' });
    const args = [path.join('tools', 'build-pool.js'), ...list];
    return startJob(list.length ? `重建地址池: ${list.join(' ')}` : '重建全部地址池', process.execPath, args, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/add-country') {
    const { code, cities } = await readBody(req);
    if (!/^[A-Z]{2}$/.test(code || '')) return send(res, 400, { error: '国家代码须为两位大写字母' });
    const n = Math.min(Math.max(parseInt(cities, 10) || 4, 1), 8);
    return startJob(`添加国家: ${code}`, process.execPath, [path.join('tools', 'add-country.js'), code, String(n)], res);
  }
  if (req.method === 'POST' && url.pathname === '/api/publish') {
    return publish(res);
  }
  send(res, 404, { error: 'Not Found' });
});

server.listen(PORT, HOST, () => {
  console.log(`后台管理已启动: http://${HOST}:${PORT}  认证: ${AUTH_ON ? '已开启' : '关闭（仅本机模式）'}`);
  if (AUTH_ON && HOST !== '127.0.0.1') {
    console.log('提示: 对公网提供服务时请务必置于 HTTPS 反向代理（Nginx/Caddy）之后。');
  }
});
