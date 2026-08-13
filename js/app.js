// 核心流程（双模式）：
// 1) 优先使用本地地址池 data/pool/<国家>.json —— 由 tools/build-pool.js 离线
//    从 OpenStreetMap 抽取的真实门牌地址，运行时零外部请求、无限流；
// 2) 地址池缺失时回退实时查询：Overpass API 随机取带门牌号的真实建筑，
//    缺失的邮编/城市再用 Nominatim 反向地理编码补全。
// 两种模式的地址均 100% 来自 OSM 实测数据。

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

let current = null;
let map = null;
let marker = null;

// ---------- 初始化 ----------
window.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('countrySelect');
  for (const [code, c] of Object.entries(COUNTRIES)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${c.name} (${c.en})`;
    sel.appendChild(opt);
  }
  sel.value = localStorage.getItem('addr_country') || 'US';
  sel.addEventListener('change', () => {
    localStorage.setItem('addr_country', sel.value);
    generate();
  });

  map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 贡献者',
  }).addTo(map);

  renderSaved();
  generate();
});

// ---------- 随机工具 ----------
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function fillPhone(tpl) {
  return tpl.replace(/[#N]/g, ch =>
    ch === 'N' ? String(2 + Math.floor(Math.random() * 8)) : String(Math.floor(Math.random() * 10)));
}

function makePerson(c) {
  const isMale = Math.random() < 0.5;
  const idx = Math.floor(Math.random() * (isMale ? c.m : c.f).length);
  const lidx = Math.floor(Math.random() * c.l.length);
  const first = (isMale ? c.m : c.f)[idx];
  const last = c.l[lidx];
  // CJK 姓名：姓在前；邮箱用罗马化
  const cjk = !!c.lr;
  const name = cjk ? last + first : `${first} ${last}`;
  const romanFirst = cjk ? (isMale ? c.mr : c.fr)[idx] : first.toLowerCase();
  const romanLast = cjk ? c.lr[lidx] : last.toLowerCase();
  const clean = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const email = `${clean(romanFirst)}${clean(romanLast)}${Math.floor(Math.random() * 900) + 100}@${pick(EMAIL_DOMAINS)}`;
  return { name, gender: isMale ? '男' : '女', email, phone: fillPhone(pick(c.phones)) };
}

// ---------- 从 OSM 获取真实地址 ----------
const poolCache = {};
async function loadPool(code) {
  if (code in poolCache) return poolCache[code];
  try {
    const resp = await fetch(`data/pool/${code}.json`);
    poolCache[code] = resp.ok ? await resp.json() : null;
  } catch (e) {
    poolCache[code] = null;
  }
  return poolCache[code];
}

async function overpassQuery(bbox, limit) {
  const q = `[out:json][timeout:25];(node["addr:housenumber"](${bbox});way["addr:housenumber"](${bbox}););out tags center ${limit};`;
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      return data.elements || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Overpass 不可用');
}

function randomBBox(city, half) {
  const [, clat, clng, r] = city;
  const ang = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * r;
  const lat = clat + Math.sin(ang) * dist;
  const lng = clng + Math.cos(ang) * dist / Math.cos(clat * Math.PI / 180);
  return `${lat - half},${lng - half},${lat + half},${lng + half}`;
}

async function findElement(c) {
  // 前 3 次在随机城市取 ~2km 小框；后 2 次扩大到 ~6km
  for (let attempt = 0; attempt < 5; attempt++) {
    const city = pick(c.cities);
    const half = attempt < 3 ? 0.01 : 0.03;
    const els = await overpassQuery(randomBBox(city, half), attempt < 3 ? 80 : 150);
    // 分级：优先街道+邮编+城市齐全的，其次有街道的，最后仅有门牌的
    const t = el => el.tags || {};
    const tierA = els.filter(el => t(el)['addr:street'] && t(el)['addr:postcode'] && t(el)['addr:city']);
    const tierB = els.filter(el => t(el)['addr:street']);
    const found = tierA.length ? tierA : tierB.length ? tierB : els;
    if (found.length) return { el: pick(found), cityName: city[0] };
  }
  return null;
}

async function nominatimReverse(lat, lng, lang) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=${encodeURIComponent(lang)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Nominatim HTTP ' + resp.status);
  return resp.json();
}

function formatLine1(fmt, street, num) {
  if (!street) return num || '';
  if (fmt === 'NS') return `${num} ${street}`;
  if (fmt === 'S,N') return `${street}, ${num}`;
  return `${street} ${num}`;
}

// ---------- 生成 ----------
async function generate() {
  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  document.getElementById('genText').textContent = '获取中…';
  document.getElementById('spinner').classList.remove('hidden');

  try {
    const code = document.getElementById('countrySelect').value;
    const c = COUNTRIES[code];
    const pool = await loadPool(code);
    current = (pool && pool.addrs && pool.addrs.length)
      ? fromPool(code, c, pool)
      : await fromLive(code, c);
    renderResult();
  } catch (e) {
    toast(e.message || '获取失败，请重试', true);
  } finally {
    btn.disabled = false;
    document.getElementById('genText').textContent = '换一个地址';
    document.getElementById('spinner').classList.add('hidden');
  }
}

// 模式一：本地地址池（离线抽取的 OSM 真实地址）
function fromPool(code, c, pool) {
  const a = pick(pool.addrs);
  const line1 = formatLine1(c.fmt, a.s, a.n);
  const address = [line1, [a.p, a.c].filter(Boolean).join(' '), c.en].filter(Boolean).join(', ');
  return {
    ...makePerson(c), address, line1, city: a.c, postcode: a.p,
    country: c.en, countryCode: code,
    lat: a.lat, lng: a.lng,
    osmUrl: `https://www.openstreetmap.org/${a.o}`,
    source: 'pool',
  };
}

// 模式二：Overpass 实时查询（地址池缺失时兜底）
async function fromLive(code, c) {
  const hit = await findElement(c);
  if (!hit) throw new Error('该区域暂未取到带门牌的地址，请再试一次');

  const { el, cityName } = hit;
  const tags = el.tags || {};
  const lat = el.lat ?? el.center.lat;
  const lng = el.lon ?? el.center.lon;

  let street = tags['addr:street'] || tags['addr:place'] || '';
  const num = tags['addr:housenumber'] || '';
  let city = tags['addr:city'] || '';
  let postcode = tags['addr:postcode'] || '';

  // 缺什么补什么：用 Nominatim 反向地理编码（同样基于 OSM 真实数据）
  if (!street || !city || !postcode) {
    try {
      const n = await nominatimReverse(lat, lng, c.lang);
      const a = n.address || {};
      street = street || a.road || a.pedestrian || a.neighbourhood || a.suburb || '';
      city = city || a.city || a.town || a.village || a.municipality || a.county || cityName;
      postcode = postcode || a.postcode || '';
    } catch (e) {
      city = city || cityName;
    }
  }

  const line1 = formatLine1(c.fmt, street, num);
  const address = [line1, [postcode, city].filter(Boolean).join(' '), c.en].filter(Boolean).join(', ');

  return {
    ...makePerson(c), address, line1, city, postcode,
    country: c.en, countryCode: code,
    lat, lng,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    source: 'live',
  };
}

// ---------- 渲染 ----------
const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function renderResult() {
  const r = current;
  const rows = [
    ['姓名', r.name], ['性别', r.gender], ['邮箱', r.email],
    ['电话', r.phone], ['地址', r.address],
    ['坐标', `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`],
  ];
  document.getElementById('result').innerHTML = rows.map(([label, val]) =>
    `<div class="field" onclick="copyText('${encodeURIComponent(val)}', true)">
       <div class="label">${label}</div><div class="value">${esc(val)}</div>
     </div>`).join('');

  const badge = document.getElementById('qualityBadge');
  badge.classList.remove('hidden');
  badge.textContent = r.source === 'pool' ? '门牌级 · 本地地址池（OSM）' : '门牌级 · OSM 实时查询';

  document.getElementById('osmProof').innerHTML =
    `真实性凭证：<a href="${esc(r.osmUrl)}" target="_blank" rel="noopener">在 OpenStreetMap 查看该建筑</a> · 地图数据 © OpenStreetMap 贡献者`;

  map.setView([r.lat, r.lng], 16);
  if (marker) marker.remove();
  marker = L.marker([r.lat, r.lng]).addTo(map).bindPopup(esc(r.address)).openPopup();
}

// ---------- 复制 ----------
function copyText(encoded, isEncoded) {
  const text = isEncoded ? decodeURIComponent(encoded) : encoded;
  const done = () => toast('已复制');
  const fail = () => toast('复制失败', true);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fail);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { fail(); }
    ta.remove();
  }
}

function copyAll() {
  if (!current) return toast('请先生成地址', true);
  const r = current;
  copyText([`姓名: ${r.name}`, `性别: ${r.gender}`, `邮箱: ${r.email}`, `电话: ${r.phone}`, `地址: ${r.address}`].join('\n'));
}

// ---------- 保存 / 导出 ----------
function getSaved() {
  try {
    const list = JSON.parse(localStorage.getItem('addr_saved') || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function saveCurrent() {
  if (!current) return toast('请先生成地址', true);
  const note = prompt('备注（可留空）：') ?? '';
  const list = getSaved();
  list.push({ note, ...current, time: new Date().toLocaleString() });
  localStorage.setItem('addr_saved', JSON.stringify(list));
  renderSaved();
  toast('已保存');
}

function delSaved(idx) {
  const list = getSaved();
  list.splice(idx, 1);
  localStorage.setItem('addr_saved', JSON.stringify(list));
  renderSaved();
}

function clearAll() {
  if (!getSaved().length) return;
  if (confirm('确定清空所有已保存的地址？')) {
    localStorage.removeItem('addr_saved');
    renderSaved();
    toast('已清空');
  }
}

function renderSaved() {
  const list = getSaved();
  const body = document.getElementById('savedBody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="no-saved">暂无保存的地址</td></tr>';
    return;
  }
  body.innerHTML = list.map((it, i) => `
    <tr>
      <td><button class="del-btn" onclick="delSaved(${i})">删除</button></td>
      <td>${esc(it.note || '-')}</td>
      <td class="copyable" onclick="copyText('${encodeURIComponent(it.name)}', true)">${esc(it.name)}</td>
      <td class="copyable" onclick="copyText('${encodeURIComponent(it.phone)}', true)">${esc(it.phone)}</td>
      <td class="copyable" onclick="copyText('${encodeURIComponent(it.address)}', true)" title="${esc(it.address)}">${esc(it.address)}</td>
      <td>${esc(it.time)}</td>
    </tr>`).join('');
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  const list = getSaved();
  if (!list.length) return toast('暂无数据', true);
  const headers = ['备注', '姓名', '性别', '邮箱', '电话', '地址', '坐标', 'OSM链接', '时间'];
  const rows = [headers.join(',')];
  list.forEach(it => {
    rows.push([it.note, it.name, it.gender, it.email, it.phone, it.address, `${it.lat} ${it.lng}`, it.osmUrl, it.time]
      .map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','));
  });
  download('﻿' + rows.join('\n'), 'addresses.csv', 'text/csv;charset=utf-8');
  toast('已导出');
}

function exportJSON() {
  const list = getSaved();
  if (!list.length) return toast('暂无数据', true);
  download(JSON.stringify(list, null, 2), 'addresses.json', 'application/json');
  toast('已导出');
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
