// 一键添加新国家：自动获取国家信息、主要城市坐标，生成 data.js 条目并抽取地址池。
// 用法：node tools/add-country.js <国家> [城市数=4] [--no-pool]
// <国家> 支持：两位/三位代码、中文名、英文名或别名，如 VN / 越南 / Vietnam / 泰国 / Thailand
// 姓名池无法可靠自动化，默认填入通用占位池（可在 data.js 中手动完善）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA_PATH = path.join(__dirname, '..', 'js', 'data.js');
const dataSrc = fs.readFileSync(DATA_PATH, 'utf8');
const COUNTRIES = new Function(dataSrc + '; return COUNTRIES;')();

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

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url.split('/')[2]} HTTP ${r.status}`);
  return r.json();
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
  const query = (args[0] || '').trim();
  const cityCount = parseInt(args[1], 10) || 4;
  if (!query) {
    console.log('用法: node tools/add-country.js <国家：代码/中文名/英文名> [城市数=4] [--no-pool]');
    process.exit(1);
  }

  console.log(`[1/4] 解析国家「${query}」（mledoze/countries 数据集）…`);
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
  console.log(`  ${zh} (${en})  区号 ${calling || '未知'}  语言 ${lang}  地址格式 ${fmt}`);

  console.log(`[2/4] 获取人口最多的 ${cityCount} 个城市（Overpass）…`);
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

  console.log('[3/4] 写入 js/data.js …');
  const cityLines = cities.map(c => `['${c.name.replace(/'/g, "\\'")}', ${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}, ${c.r ?? radiusFor(c.pop)}]`).join(', ');
  const phones = calling ? `['${calling} ### ### ###']` : `['+000 ### ### ###'] /* 未获取到区号，请手动修正 */`;
  const arr = a => `[${a.map(x => `'${x}'`).join(', ')}]`;
  const entry = `  ${code}: { // 由 add-country.js 自动生成；姓名池为通用占位，建议按当地习惯完善
    name: '${zh}', en: '${en}', lang: '${lang}', fmt: '${fmt}',
    cities: [${cityLines}],
    phones: ${phones},
    m: ${arr(GENERIC_NAMES.m)},
    f: ${arr(GENERIC_NAMES.f)},
    l: ${arr(GENERIC_NAMES.l)},
  },
`;
  // 插入到 COUNTRIES 结尾（EMAIL_DOMAINS 之前最后一个 "};"），对 CRLF/LF 行尾均兼容
  const domIdx = dataSrc.lastIndexOf('const EMAIL_DOMAINS');
  const closeIdx = domIdx > 0 ? dataSrc.lastIndexOf('};', domIdx) : -1;
  if (closeIdx < 0) {
    console.log('  未找到 data.js 插入点（COUNTRIES 结尾），请手动插入以下内容：\n' + entry);
    process.exit(1);
  }
  fs.writeFileSync(DATA_PATH, dataSrc.slice(0, closeIdx) + entry + dataSrc.slice(closeIdx));
  console.log(`  已添加 ${code} 条目`);

  if (noPool) {
    console.log('[4/4] 跳过地址池抽取（--no-pool）。之后可运行: node tools/build-pool.js ' + code);
    return;
  }
  console.log(`[4/4] 抽取 ${code} 地址池（数分钟）…`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build-pool.js'), code], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('地址池抽取失败，可稍后重试: node tools/build-pool.js ' + code);
    return;
  }
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'pool', code + '.json'), 'utf8'));
    if (pool.count < 500) {
      console.log(`⚠ ${code} 仅抽到 ${pool.count} 条——该国/地区 OSM 门牌覆盖较差，站点将频繁复用少量地址，请酌情考虑是否保留。`);
    } else {
      console.log(`✔ ${code} 添加完成，地址池 ${pool.count} 条。记得在 data.js 中完善姓名池与电话格式。`);
    }
  } catch (e) { /* 汇总仅供参考 */ }
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
