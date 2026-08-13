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

// 常用推荐国家代码（用于快捷 Pill 按钮）
const FEATURED_COUNTRIES = ['US', 'JP', 'GB', 'DE', 'KR', 'SG', 'AU', 'TW', 'FR', 'CA', 'VN'];

let current = null;
let map = null;
let marker = null;
let currentTileLayer = null;

// SVG 图标定义
const ICONS = {
  user: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  gender: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>`,
  phone: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  mail: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  home: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
  city: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>`,
  postcode: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>`,
  pin: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
  check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

// ---------- 初始化 ----------
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initCountrySelector();
  initCountryPills();
  initMap();
  initShortcuts();
  initSearch();
  renderSaved();
  generate();
});

// ---------- 主题切换 ----------
function initTheme() {
  const savedTheme = localStorage.getItem('addr_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('addr_theme', newTheme);
  updateThemeIcon(newTheme);
  updateMapTiles(newTheme);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('themeBtn');
  if (!btn) return;
  btn.innerHTML = theme === 'dark'
    ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

// ---------- 国家选择器 & Pill 标签 ----------
function initCountrySelector() {
  const sel = document.getElementById('countrySelect');
  sel.innerHTML = '';
  for (const [code, c] of Object.entries(COUNTRIES)) {
    const opt = document.createElement('option');
    opt.value = code;
    const flag = c.flag ? c.flag + ' ' : '';
    opt.textContent = `${flag}${c.name} (${c.en})`;
    sel.appendChild(opt);
  }
  sel.value = localStorage.getItem('addr_country') || 'US';
  sel.addEventListener('change', () => {
    localStorage.setItem('addr_country', sel.value);
    highlightPill(sel.value);
    generate();
  });
}

function initCountryPills() {
  const container = document.getElementById('countryPills');
  if (!container) return;
  container.innerHTML = '';
  
  const currentCode = localStorage.getItem('addr_country') || 'US';

  FEATURED_COUNTRIES.forEach(code => {
    const c = COUNTRIES[code];
    if (!c) return;
    const btn = document.createElement('button');
    btn.className = `country-pill ${code === currentCode ? 'active' : ''}`;
    btn.dataset.code = code;
    btn.innerHTML = `<span>${c.flag || ''}</span> <span>${c.name}</span>`;
    btn.onclick = () => {
      document.getElementById('countrySelect').value = code;
      localStorage.setItem('addr_country', code);
      highlightPill(code);
      generate();
    };
    container.appendChild(btn);
  });
}

function highlightPill(code) {
  document.querySelectorAll('.country-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.code === code);
  });
}

// ---------- 地图初始化 ----------
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  updateMapTiles(theme);
}

function updateMapTiles(theme) {
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  
  const tileUrl = theme === 'dark'
    ? 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
    : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  currentTileLayer = L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 贡献者',
  }).addTo(map);
}

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
  for (let attempt = 0; attempt < 5; attempt++) {
    const city = pick(c.cities);
    const half = attempt < 3 ? 0.01 : 0.03;
    const els = await overpassQuery(randomBBox(city, half), attempt < 3 ? 80 : 150);
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

// 模式一：本地地址池
function fromPool(code, c, pool) {
  const a = pick(pool.addrs);
  const line1 = formatLine1(c.fmt, a.s, a.n);
  const address = [line1, [a.p, a.c].filter(Boolean).join(' '), c.en].filter(Boolean).join(', ');
  return {
    ...makePerson(c), address, line1, city: a.c, postcode: a.p,
    country: c.en, countryCode: code, flag: c.flag || '',
    lat: a.lat, lng: a.lng,
    osmUrl: `https://www.openstreetmap.org/${a.o}`,
    source: 'pool',
  };
}

// 模式二：Overpass 实时查询
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
    country: c.en, countryCode: code, flag: c.flag || '',
    lat, lng,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    source: 'live',
  };
}

// ---------- 渲染结果 ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function renderResult() {
  const r = current;
  if (!r) return;

  const fields = [
    { icon: ICONS.user, label: '姓名 (Name)', val: r.name, raw: r.name },
    { icon: ICONS.gender, label: '性别 (Gender)', val: r.gender, raw: r.gender },
    { icon: ICONS.phone, label: '电话号码', val: r.phone, raw: r.phone },
    { icon: ICONS.mail, label: '电子邮箱', val: r.email, raw: r.email },
    { icon: ICONS.home, label: '街道门牌', val: r.line1 || '-', raw: r.line1 },
    { icon: ICONS.city, label: '城市 (City)', val: r.city || '-', raw: r.city },
    { icon: ICONS.postcode, label: '邮政编码', val: r.postcode || '-', raw: r.postcode },
    { icon: ICONS.pin, label: '完整物理地址', val: `${r.flag ? r.flag + ' ' : ''}${r.address}`, raw: r.address, fullWidth: true },
    { icon: ICONS.pin, label: 'WGS84 坐标', val: `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`, raw: `${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`, isMono: true, fullWidth: true },
  ];

  document.getElementById('result').innerHTML = fields.map(f => `
    <div class="field-card ${f.fullWidth ? 'full-width' : ''}" onclick="copyText('${encodeURIComponent(f.raw)}', true, '${esc(f.label)}')">
      <div class="field-icon">${f.icon}</div>
      <div class="field-label">${f.label}</div>
      <div class="field-value ${f.isMono ? 'mono' : ''}">${esc(f.val)}</div>
      <div class="field-copy-btn" title="点击复制">${ICONS.copy}</div>
    </div>
  `).join('');

  // 质量 Indicator Badge
  const badge = document.getElementById('qualityBadge');
  if (badge) {
    badge.className = 'status-badge';
    badge.innerHTML = `<span class="status-pulse"></span> ${r.source === 'pool' ? '门牌级 · 本地地址池 (OSM)' : '门牌级 · OSM 实时抓取'}`;
  }

  // 证明链接
  const osmProof = document.getElementById('osmProof');
  if (osmProof) {
    osmProof.innerHTML = `
      <div class="proof-links">
        <a href="${esc(r.osmUrl)}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          在 OpenStreetMap 验证建筑
        </a>
        <a href="https://maps.google.com/?q=${r.lat},${r.lng}" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/></svg>
          Google Maps
        </a>
      </div>
      <div>地图数据 © OpenStreetMap 贡献者</div>
    `;
  }

  // 更新地图
  map.setView([r.lat, r.lng], 16);
  if (marker) marker.remove();

  // 自定义 Pulsing Marker
  const customIcon = L.divIcon({
    className: 'custom-map-pin',
    html: `<div style="position:relative;">
            <div style="width:24px;height:24px;background:#0EA5E9;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(14,165,233,0.8);"></div>
            <div style="position:absolute;top:-6px;left:-6px;width:36px;height:36px;border-radius:50%;background:rgba(14,165,233,0.3);animation:pulse-ring 1.8s infinite;"></div>
          </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  marker = L.marker([r.lat, r.lng], { icon: customIcon }).addTo(map)
    .bindPopup(`<div style="font-family:var(--font-main);padding:4px;"><strong style="color:#0EA5E9;">${esc(r.name)}</strong><br>${esc(r.address)}</div>`)
    .openPopup();
}

// ---------- 快捷复制多格式 ----------
function copyText(encoded, isEncoded, label = '内容') {
  const text = isEncoded ? decodeURIComponent(encoded) : encoded;
  const done = () => toast(`已复制 ${label}`);
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
  const text = [
    `姓名: ${r.name}`,
    `性别: ${r.gender}`,
    `电话: ${r.phone}`,
    `邮箱: ${r.email}`,
    `地址: ${r.address}`,
    `坐标: ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`,
    `验证: ${r.osmUrl}`
  ].join('\n');
  copyText(text, false, '全套地址信息');
}

function copyJSON() {
  if (!current) return toast('请先生成地址', true);
  copyText(JSON.stringify(current, null, 2), false, 'JSON 数据');
}

function copyCoordinates() {
  if (!current) return toast('请先生成地址', true);
  copyText(`${current.lat.toFixed(6)}, ${current.lng.toFixed(6)}`, false, '经纬度坐标');
}

function centerMap() {
  if (current && map) {
    map.setView([current.lat, current.lng], 16);
    toast('已重置地图焦点');
  }
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
  const note = prompt('给该地址添加备注（可选）：') ?? '';
  const list = getSaved();
  list.unshift({ note, ...current, time: new Date().toLocaleString() });
  localStorage.setItem('addr_saved', JSON.stringify(list));
  renderSaved();
  toast('已成功保存地址');
}

function delSaved(idx) {
  const list = getSaved();
  list.splice(idx, 1);
  localStorage.setItem('addr_saved', JSON.stringify(list));
  renderSaved();
  toast('已删除条目');
}

function clearAll() {
  if (!getSaved().length) return;
  if (confirm('确定要清空所有已保存的地址记录吗？')) {
    localStorage.removeItem('addr_saved');
    renderSaved();
    toast('所有记录已清空');
  }
}

function initSearch() {
  const input = document.getElementById('searchInput');
  if (input) {
    input.addEventListener('input', () => renderSaved());
  }
}

function renderSaved() {
  const list = getSaved();
  const searchKey = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  
  const filtered = list.filter(item => {
    if (!searchKey) return true;
    return (item.name || '').toLowerCase().includes(searchKey) ||
           (item.address || '').toLowerCase().includes(searchKey) ||
           (item.phone || '').includes(searchKey) ||
           (item.note || '').toLowerCase().includes(searchKey) ||
           (item.country || '').toLowerCase().includes(searchKey);
  });

  const countBadge = document.getElementById('savedCountBadge');
  if (countBadge) countBadge.textContent = list.length;

  const body = document.getElementById('savedBody');
  if (!body) return;

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-state">
      <div class="empty-icon">📂</div>
      <div>${list.length ? '没有匹配的搜索结果' : '暂无保存的地址数据，点击"保存当前"进行添加'}</div>
    </td></tr>`;
    return;
  }

  body.innerHTML = filtered.map((it, i) => `
    <tr>
      <td>
        <button class="btn btn-danger btn-ghost" style="padding:4px 8px;" onclick="delSaved(${i})" title="删除此记录">
          ${ICONS.copy.replace('rect', 'path')}
          删除
        </button>
      </td>
      <td><span class="note-tag">${esc(it.note || '-')}</span></td>
      <td><span class="country-flag-cell">${it.flag || ''} ${esc(it.countryCode || '-')}</span></td>
      <td class="cell-copyable" onclick="copyText('${encodeURIComponent(it.name)}', true, '姓名')"><strong>${esc(it.name)}</strong></td>
      <td class="cell-copyable" onclick="copyText('${encodeURIComponent(it.phone)}', true, '电话')">${esc(it.phone)}</td>
      <td class="cell-copyable" onclick="copyText('${encodeURIComponent(it.address)}', true, '地址')" title="${esc(it.address)}">${esc(it.address)}</td>
      <td style="font-size:0.78rem;color:var(--text-muted);">${esc(it.time)}</td>
    </tr>
  `).join('');
}

// ---------- 导出功能 ----------
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
  if (!list.length) return toast('暂无保存数据可导出', true);
  const headers = ['备注', '国家/地区', '姓名', '性别', '邮箱', '电话', '完整地址', '街道门牌', '城市', '邮编', '纬度', '经度', 'OSM链接', '保存时间'];
  const rows = [headers.join(',')];
  list.forEach(it => {
    rows.push([it.note, it.country, it.name, it.gender, it.email, it.phone, it.address, it.line1, it.city, it.postcode, it.lat, it.lng, it.osmUrl, it.time]
      .map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','));
  });
  download('\uFEFF' + rows.join('\n'), `osm_addresses_${Date.now()}.csv`, 'text/csv;charset=utf-8');
  toast('已成功导出 CSV 文件');
}

function exportJSON() {
  const list = getSaved();
  if (!list.length) return toast('暂无保存数据可导出', true);
  download(JSON.stringify(list, null, 2), `osm_addresses_${Date.now()}.json`, 'application/json');
  toast('已成功导出 JSON 文件');
}

// ---------- Toast 通知 ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      ${isError ? '⚠️' : '✅'} <span>${esc(msg)}</span>
    </div>
  `;
  el.className = `toast show ${isError ? 'toast-error' : ''}`;
  
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2200);
}

// ---------- 快捷键监听 ----------
function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    // 忽略文本框中的输入
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    
    if (e.code === 'Space') {
      e.preventDefault();
      generate();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      saveCurrent();
    } else if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      copyAll();
    }
  });
}

function toggleModal() {
  const modal = document.getElementById('shortcutModal');
  if (modal) modal.classList.toggle('active');
}
