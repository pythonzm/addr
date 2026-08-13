// 本地后台管理服务：可视化触发地址池重建、添加国家、发布到远端（git push）。
// 用法：node tools/admin-server.js  → 打开 http://127.0.0.1:8100
// 仅绑定本机回环地址，不对外暴露；同一时刻只允许一个任务运行（Overpass 礼仪）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8100;

let job = null; // 当前/最近一次任务 {name, logs[], status: running|done|failed, started}

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
    if (i >= steps.length) { appendLog('—— 发布完成，GitHub Pages 将自动重新部署 ——'); job.status = 'done'; return; }
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
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'admin.html')));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, { countries: loadStatus(), job: job && { name: job.name, status: job.status, started: job.started } });
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`后台管理已启动: http://127.0.0.1:${PORT}`);
});
