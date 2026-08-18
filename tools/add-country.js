// 一键添加新国家：自动获取国家信息、主要城市坐标，生成 data.js 条目并抽取地址池。
// 用法：node tools/add-country.js <国家> [城市数=4] [--postal-format=<模板>] [--no-administrative-area] [--no-pool]
// <国家> 支持：两位/三位代码、中文名、英文名或别名，如 VN / 越南 / Vietnam / 泰国 / Thailand
// 电话模板与姓名池自动来自开源数据集（Google libphonenumber + popular-names-by-country），
// 数据集未覆盖或获取失败时回退通用占位池。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPendingCountry, claimPendingCountry, clearPendingCountry } = require('./country-pending');

const DATA_PATH = path.join(__dirname, '..', 'js', 'data.js');
const dataSrc = fs.readFileSync(DATA_PATH, 'utf8');
const { COUNTRIES, POSTAL_FORMATS, postalFormatForCountry } = new Function(
  dataSrc + '; return { COUNTRIES, POSTAL_FORMATS, postalFormatForCountry };'
)();

// ISO 639-3 -> Nominatim 用的语言代码（常见语言，未覆盖的回退 en）
const LANG_MAP = {
  eng: 'en', fra: 'fr', spa: 'es', por: 'pt', deu: 'de', ita: 'it', nld: 'nl',
  swe: 'sv', pol: 'pl', ces: 'cs', jpn: 'ja', kor: 'ko', zho: 'zh', vie: 'vi',
  tha: 'th', ind: 'id', msa: 'ms', tur: 'tr', ell: 'el', dan: 'da', fin: 'fi',
  nor: 'no', nob: 'no', ron: 'ro', hun: 'hu', rus: 'ru', ukr: 'uk', ara: 'ar',
  heb: 'he', hin: 'hi', ben: 'bn', tgl: 'tl', bul: 'bg', hrv: 'hr', srp: 'sr',
  slk: 'sk', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et', cat: 'ca',
};

// 通用占位姓名池（拉丁字母，保证邮箱可用；建议按当地习惯手动替换）
const GENERIC_NAMES = {
  m: ['Alex', 'David', 'Daniel', 'Kevin', 'Leo', 'Max', 'Tom', 'Sam'],
  f: ['Anna', 'Maria', 'Sara', 'Emma', 'Mia', 'Lena', 'Eva', 'Nina'],
  l: ['Nguyen', 'Santos', 'Novak', 'Kova', 'Petrov', 'Haddad', 'Okoro', 'Yilmaz'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 所有网络请求统一走 curl（Node 内置 fetch 不走 HTTP(S)_PROXY 代理环境变量）。
// 部分域名需代理、部分域名代理反而不通：先按环境变量走代理，失败自动重试直连；
// opts.validate 可校验响应内容（识别代理返回的错误页并触发重试）。
async function fetchRaw(url, opts = {}) {
  const base = ['-sSf', '--max-time', '120', url];
  for (const [k, v] of Object.entries(opts.headers || {})) base.push('-H', `${k}: ${v}`);
  if (opts.body) base.push('--data-raw', opts.body);
  let lastErr;
  for (const extra of [[], ['--noproxy', '*']]) {
    const r = spawnSync('curl', [...base, ...extra], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    try {
      if (r.error) throw r.error;
      if (r.status !== 0) throw new Error(`curl 退出码 ${r.status}` + (r.stderr ? `：${String(r.stderr).trim().slice(0, 150)}` : ''));
      if (opts.validate && !opts.validate(r.stdout)) throw new Error('响应内容异常');
      return r.stdout;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`${url.split('/')[2]} 请求失败（代理与直连均不通）：${lastErr.message.slice(0, 150)}`);
}

async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchRaw(url, {
    ...opts,
    validate: s => { try { JSON.parse(s); return true; } catch { return false; } },
  }));
}

// ---------- 从开源数据集生成电话模板与姓名池 ----------
// 电话：Google libphonenumber 元数据（各国手机示例号码 → 真实号段模板）
// 姓名：sigpwned/popular-names-by-country-dataset（106 国常用名/75 国姓氏，带性别与罗马化）
const PHONE_META_URL = 'https://raw.githubusercontent.com/google/libphonenumber/master/resources/PhoneNumberMetadata.xml';
const NAMES_BASE = 'https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main';

// 极简 CSV 解析（支持引号字段）
function csvRows(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

// 含基本拉丁/扩展拉丁之外的字符即视为非拉丁文字（需附罗马化池）
const nonLatin = s => /[^\u0020-\u024F\u1E00-\u1EFF\s.'\u2019-]/.test(s);

// 手机模板：取该国 mobile 示例号码，保留真实前缀，其余数字换成 #，按 3/4 位分组
async function phoneTemplate(iso, calling) {
  if (!calling) return null;
  const xml = await fetchRaw(PHONE_META_URL, { validate: s => s.includes('<territory') });
  const terr = xml.match(new RegExp(`<territory id="${iso}"[\\s\\S]*?</territory>`));
  const ex = terr && terr[0].match(/<mobile>[\s\S]*?<exampleNumber>(\d+)<\/exampleNumber>/);
  if (!ex) return null;
  const num = ex[1];
  const keep = num.length >= 9 ? 3 : 2;
  let rest = num.length - keep;
  const groups = [];
  while (rest > 4) { groups.push('###'); rest -= 3; }
  groups.push('#'.repeat(rest));
  return `${calling} ${num.slice(0, keep)} ${groups.join(' ')}`;
}

// 姓名池：按国家取常用男名/女名/姓氏各前 8（本地文字 + 罗马化）
async function namePools(iso) {
  const csvOpts = { validate: s => s.includes(',') && /Country/i.test(s.slice(0, 200)) };
  const fn = csvRows(await fetchRaw(NAMES_BASE + '/common-forenames-by-country.csv', csvOpts)).filter(r => r[0].replace(/^﻿/, '') === iso);
  const sn = csvRows(await fetchRaw(NAMES_BASE + '/common-surnames-by-country.csv', csvOpts)).filter(r => r[0].replace(/^﻿/, '') === iso);
  // 列位：名 CSV [9]=Gender [10]=Localized [11]=Romanized；姓 CSV [4]=Localized [5]=Romanized
  const pick = (rows, li, ri) => {
    const loc = [], rom = [], seen = new Set();
    for (const r of rows) {
      // U+0301 为组合重音符（数据集源自维基百科，常带注音标记），显示时应去除
      const strip = v => (v || '').trim().replace(/\u0301/g, '');
      const l = strip(r[li]), ro = strip(r[ri]), name = l || ro;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      loc.push(name);
      rom.push((ro || l).toLowerCase());
      if (loc.length >= 8) break;
    }
    return { loc, rom };
  };
  return {
    m: pick(fn.filter(r => r[9] === 'M'), 10, 11),
    f: pick(fn.filter(r => r[9] === 'F'), 10, 11),
    l: pick(sn, 4, 5),
  };
}

// 汇总：任一来源失败不影响其余，缺的字段返回 null 由调用方回退占位池
async function datasetEnrich(iso, calling) {
  const gen = { phones: null, m: null, f: null, l: null, mr: null, fr: null, lr: null };
  try { gen.phones = await phoneTemplate(iso, calling); }
  catch (e) { console.log('  电话数据集获取失败：' + e.message); }
  try {
    const n = await namePools(iso);
    if (n.m.loc.length >= 4 && n.f.loc.length >= 4) { gen.m = n.m.loc; gen.f = n.f.loc; gen.mr = n.m.rom; gen.fr = n.f.rom; }
    if (n.l.loc.length >= 4) { gen.l = n.l.loc; gen.lr = n.l.rom; }
  } catch (e) { console.log('  姓名数据集获取失败：' + e.message); }
  return gen;
}

async function overpassCities(iso, count) {
  // 不限定 admin_level：香港/澳门等特别行政区的边界关系不是 admin_level=2
  const q = `[out:json][timeout:60];area["ISO3166-1"="${iso}"]->.a;(node["place"~"^(city|town)$"]["population"](area.a););out tags center 500;`;
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  let els = null, lastErr;
  for (const url of endpoints) {
    try {
      const data = await fetchJson(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'addr-generator-add-country/1.0' },
      });
      els = data.elements || [];
      break;
    } catch (e) { lastErr = e; await sleep(1500); }
  }
  if (!els) throw lastErr;
  const cities = els
    .map(el => ({ name: el.tags['name:en'] || el.tags.name, lat: el.lat, lng: el.lon, pop: parseInt(String(el.tags.population).replace(/\D/g, ''), 10) || 0 }))
    .filter(c => c.name && c.pop > 0)
    .sort((a, b) => b.pop - a.pop);
  // 去掉重名（同城多节点取人口最大的）
  const seen = new Set();
  const uniq = cities.filter(c => !seen.has(c.name) && seen.add(c.name));
  return uniq.slice(0, count);
}

function radiusFor(pop) {
  if (pop >= 5e6) return 0.07;
  if (pop >= 2e6) return 0.05;
  if (pop >= 8e5) return 0.04;
  return 0.03;
}

// 按代码/中文名/英文名/别名解析国家；返回匹配数组
function resolveCountry(all, query) {
  const q = String(query).trim().toLowerCase();
  const norm = v => String(v || '').toLowerCase();
  const fields = c => [c.cca2, c.cca3, c.name?.common, c.name?.official, c.translations?.zho?.common, c.translations?.zho?.official, ...(c.altSpellings || [])];
  let hit = all.filter(c => fields(c).some(v => norm(v) === q));
  if (!hit.length) hit = all.filter(c => fields(c).some(v => norm(v).startsWith(q)));
  if (!hit.length) hit = all.filter(c => fields(c).some(v => norm(v).includes(q)));
  return hit;
}

(async () => {
  const args = process.argv.slice(2).filter(a => a !== '--no-pool');
  const noPool = process.argv.includes('--no-pool');
  const postalArg = process.argv.find(a => a.startsWith('--postal-format='));
  const noAdministrativeArea = process.argv.includes('--no-administrative-area');
  const query = (args[0] || '').trim();
  const cityCount = parseInt(args[1], 10) || 4;
  if (!query) {
    console.log('用法: node tools/add-country.js <国家：代码/中文名/英文名> [城市数=4] [--no-pool]');
    process.exit(1);
  }
  const existingPending = readPendingCountry();
  if (existingPending) {
    console.log(`尚有待校验国家 ${existingPending.code || '未知'}，请先运行 tools/rebuild-pools.js ${existingPending.code || ''} 完成或清理该任务。`);
    process.exit(1);
  }

  console.log(`[1/5] 解析国家「${query}」（mledoze/countries 数据集）…`);
  const all = await fetchJson('https://raw.githubusercontent.com/mledoze/countries/master/countries.json');
  const matches = resolveCountry(all, query);
  if (!matches.length) {
    console.log('  未匹配到任何国家/地区，请检查拼写');
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log('  匹配到多个，请用更精确的名称或代码重试：');
    matches.slice(0, 8).forEach(c => console.log(`    ${c.translations?.zho?.common || c.name.common} (${c.name.common}, ${c.cca2})`));
    process.exit(1);
  }
  const info = matches[0];
  // 数据键沿用现有约定：英国用 UK（而非 ISO 的 GB）
  const code = info.cca2 === 'GB' ? 'UK' : info.cca2;
  const iso = info.cca2;
  if (COUNTRIES[code]) {
    console.log(`  ${info.translations?.zho?.common || info.name.common} (${code}) 已存在于 data.js，无需添加`);
    process.exit(1);
  }
  const en = info.name.common;
  const zh = info.translations?.zho?.common || en;
  const calling = (info.idd?.root || '') + (info.idd?.suffixes?.length === 1 ? info.idd.suffixes[0] : '');
  const langKey = Object.keys(info.languages || {})[0];
  const lang = LANG_MAP[langKey] || 'en';
  const fmt = (lang === 'en' || lang === 'fr') ? 'NS' : (lang === 'es' || lang === 'pt') ? 'S,N' : 'SN';
  const allowedPostalFormats = new Set(Object.keys(POSTAL_FORMATS));
  const requestedPostalFormat = postalArg?.split('=')[1] || 'auto';
  if (requestedPostalFormat !== 'auto' && !allowedPostalFormats.has(requestedPostalFormat)) {
    console.log(`  不支持的邮政格式：${requestedPostalFormat}`);
    process.exit(1);
  }
  const postalFormat = requestedPostalFormat === 'auto' ? postalFormatForCountry(code) : requestedPostalFormat;
  console.log(`  ${zh} (${en})  区号 ${calling || '未知'}  语言 ${lang}  门牌格式 ${fmt}  邮政格式 ${postalFormat}`);

  console.log(`[2/5] 获取人口最多的 ${cityCount} 个城市（Overpass）…`);
  let cities = await overpassCities(iso, cityCount);
  if (!cities.length) {
    // 城邦/特别行政区常无带人口标注的 place 节点：退回用数据集中心坐标作单一城市
    const [clat, clng] = info.latlng || [];
    if (clat == null) {
      console.log('  未找到带人口标注的城市，且数据集无中心坐标，请手动编辑 data.js');
      process.exit(1);
    }
    console.log(`  未找到带人口标注的城市，退回使用 ${en} 中心点作为单一覆盖区域`);
    cities = [{ name: en, lat: clat, lng: clng, pop: 0, r: 0.1 }];
  }
  for (const c of cities) console.log(`  ${c.name}  (${c.lat.toFixed(2)}, ${c.lng.toFixed(2)})  人口 ${c.pop ? c.pop.toLocaleString() : '未知'}`);

  console.log('[3/5] 从开源数据集生成电话模板与姓名池…');
  const gen = await datasetEnrich(iso, calling);
  if (gen.phones) console.log(`  电话模板：${gen.phones}`);
  else console.log('  数据集无该国手机号样例，回退区号通用模板');
  if (gen.m) console.log(`  姓名池：男 ${gen.m.slice(0, 3).join('/')}…  女 ${gen.f.slice(0, 3).join('/')}…`);
  if (gen.l) console.log(`  姓氏池：${gen.l.slice(0, 3).join('/')}…`);
  if (!gen.m || !gen.l) console.log('  姓名数据集未覆盖的部分回退通用占位池（可在 data.js 手动完善）');

  console.log('[4/5] 写入 js/data.js …');
  const cityLines = cities.map(c => `['${c.name.replace(/'/g, "\\'")}', ${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}, ${c.r ?? radiusFor(c.pop)}]`).join(', ');
  const arr = a => `[${a.map(x => `'${String(x).replace(/'/g, "\\'")}'`).join(', ')}]`;
  const phones = gen.phones ? `['${gen.phones}']`
    : calling ? `['${calling} ### ### ###'] /* 数据集未覆盖，粗糙模板，建议修正 */`
    : `['+000 ### ### ###'] /* 未获取到区号，请手动修正 */`;
  // 姓名含非拉丁文字时按站内约定附带罗马化池（用于生成邮箱）
  const useRoman = gen.m && gen.f && gen.l && [...gen.m, ...gen.f, ...gen.l].some(nonLatin);
  const roman = useRoman ? `\n    mr: ${arr(gen.mr)}, fr: ${arr(gen.fr)}, lr: ${arr(gen.lr)},` : '';
  const full = gen.phones && gen.m && gen.l;
  // 收尾提示按字段精确说明，避免"已自动生成却提示手动完善"的误导
  const missing = [!gen.phones && '电话模板', !gen.m && '男/女名', !gen.l && '姓氏'].filter(Boolean);
  const genNote = full
    ? '电话与姓名池均来自开源数据集，无需手动补充。'
    : `${missing.join('、')}数据集未覆盖（已填占位，如需更真实可在 data.js 中完善），其余字段已自动生成。`;
  const entry = `  ${code}: { // 由 add-country.js 自动生成${full ? '（电话/姓名池来自开源数据集）' : '；部分字段为通用占位，建议按当地习惯完善'}
    name: '${zh}', en: '${en}', lang: '${lang}', fmt: '${fmt}', postalFormat: '${postalFormat}',${noAdministrativeArea ? ' noAdministrativeArea: true,' : ''}
    cities: [${cityLines}],
    phones: ${phones},
    m: ${arr(gen.m || GENERIC_NAMES.m)},
    f: ${arr(gen.f || GENERIC_NAMES.f)},
    l: ${arr(gen.l || GENERIC_NAMES.l)},${roman}
  },
`;
  // 使用显式标记找 COUNTRIES 结尾，避免被后续函数/对象中的 "};" 误导。
  const markerIdx = dataSrc.indexOf('// END COUNTRIES');
  const closeIdx = markerIdx > 0 ? dataSrc.lastIndexOf('};', markerIdx) : -1;
  if (closeIdx < 0) {
    console.log('  未找到 data.js 插入点（COUNTRIES 结尾），请手动插入以下内容：\n' + entry);
    process.exit(1);
  }
  if (!claimPendingCountry(code)) {
    console.log('另一个新增国家任务已抢先进入校验阶段，本次未写入任何配置。');
    process.exit(1);
  }
  fs.writeFileSync(DATA_PATH, dataSrc.slice(0, closeIdx) + entry + dataSrc.slice(closeIdx));
  console.log(`  已添加 ${code} 条目`);

  if (noPool) {
    console.log('[5/5] 跳过地址池抽取（--no-pool）。之后可运行: node tools/rebuild-pools.js ' + code);
    console.log('  ' + genNote);
    return;
  }
  console.log(`[5/5] 抽取 ${code} 地址池、补齐行政区并校验（数分钟）…`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'rebuild-pools.js'), code], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('地址池构建/行政区补全/校验失败，未发布。可稍后重试: node tools/rebuild-pools.js ' + code);
    fs.writeFileSync(DATA_PATH, dataSrc);
    const poolPath = path.join(__dirname, '..', 'data', 'pool', code + '.json');
    if (fs.existsSync(poolPath)) fs.unlinkSync(poolPath);
    clearPendingCountry();
    console.log(`  已回滚 ${code} 的国家配置和不完整地址池。`);
    process.exit(1);
  }
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'pool', code + '.json'), 'utf8'));
    if (pool.count < 500) {
      console.log(`⚠ ${code} 仅抽到 ${pool.count} 条——该国/地区 OSM 门牌覆盖较差，站点将频繁复用少量地址，请酌情考虑是否保留。`);
      console.log('  ' + genNote);
    } else {
      console.log(`✔ ${code} 添加完成，地址池 ${pool.count} 条。${genNote}`);
    }
  } catch (e) { /* 汇总仅供参考 */ }
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
