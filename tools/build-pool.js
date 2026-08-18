// 地址池抽取脚本：从公共 Overpass API 为每个国家抽取门牌级真实地址，
// 输出 data/pool/<国家代码>.json，供站点离线随机取用。
// 用法：node tools/build-pool.js            # 全部国家
//       node tools/build-pool.js DE JP     # 指定国家
// 频率已做限制（每次查询间隔 800ms），符合公共 Overpass 使用礼仪。

const fs = require('fs');
const path = require('path');

const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const { COUNTRIES, NO_ADMINISTRATIVE_AREA_CODES, administrativeAreaFromOsmTags } = new Function(
  dataSrc + '; return { COUNTRIES, NO_ADMINISTRATIVE_AREA_CODES, administrativeAreaFromOsmTags };'
)();

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const TARGET = 2500;   // 每国目标条数
const MIN_OK = 800;    // 低于此数触发放宽条件的补充抽取
const OUT_DIR = path.join(__dirname, '..', 'data', 'pool');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = a => a[Math.floor(Math.random() * a.length)];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomBBox(city, half) {
  const [, clat, clng, r] = city;
  const ang = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * r;
  const lat = clat + Math.sin(ang) * dist;
  const lng = clng + Math.cos(ang) * dist / Math.cos(clat * Math.PI / 180);
  return `${lat - half},${lng - half},${lat + half},${lng + half}`;
}

async function overpass(filters, bbox, limit) {
  const q = `[out:json][timeout:40];(node${filters}(${bbox});way${filters}(${bbox}););out tags center ${limit};`;
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'addr-pool-builder/1.0' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements || [];
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    }
  }
  throw lastErr;
}

// 从元素提取地址；strict=true 要求邮编+城市齐全
function extract(el, cityName, strict, code) {
  const t = el.tags || {};
  const n = t['addr:housenumber'];
  const s = t['addr:street'] || t['addr:place'] || t['addr:neighbourhood'] || t['addr:quarter'] || t['addr:suburb'] || '';
  const p = t['addr:postcode'] || '';
  const c = t['addr:city'] || (strict ? '' : cityName);
  if (!n || !s || !c) return null;
  if (strict && !p) return null;
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  const a = NO_ADMINISTRATIVE_AREA_CODES.has(code) ? '' : administrativeAreaFromOsmTags(t);
  return {
    n, s, p, c,
    ...(a ? { a, as: 'osm' } : {}),
    lat: +lat.toFixed(6), lng: +lng.toFixed(6),
    o: `${el.type}/${el.id}`,
  };
}

async function buildCountry(code) {
  const country = COUNTRIES[code];
  const pool = new Map(); // key: osm ref
  const seen = new Set(); // key: 街道+门牌+城市，防止同一地址多条目

  const add = rec => {
    if (!rec || pool.has(rec.o)) return false;
    const k = `${rec.s}|${rec.n}|${rec.c}`;
    if (seen.has(k)) return false;
    pool.set(rec.o, rec);
    seen.add(k);
    return true;
  };

  // 第一轮：严格条件（门牌+邮编+城市 tag 齐全，Overpass 侧过滤）
  const strictFilters = '["addr:housenumber"]["addr:postcode"]["addr:city"]';
  const perCity = Math.ceil(TARGET / country.cities.length);
  for (const city of country.cities) {
    let got = 0;
    for (let t = 0; t < 6 && got < perCity && pool.size < TARGET; t++) {
      try {
        const els = await overpass(strictFilters, randomBBox(city, 0.02), 400);
        for (const el of els) if (add(extract(el, city[0], true, code))) got++;
        process.stdout.write(`  ${code}/${city[0]} 第${t + 1}轮: +${els.length} 原始, 累计 ${pool.size}\n`);
      } catch (e) {
        process.stdout.write(`  ${code}/${city[0]} 第${t + 1}轮失败: ${e.message}\n`);
      }
      await sleep(800);
    }
  }

  // 第二轮（数量不足时放宽）：仅要求门牌+街道，城市名用已知城市回填，邮编可空
  if (pool.size < MIN_OK) {
    process.stdout.write(`  ${code} 严格模式仅 ${pool.size} 条，放宽条件补充…\n`);
    const looseFilters = '["addr:housenumber"]["addr:street"]';
    for (const city of country.cities) {
      for (let t = 0; t < 4 && pool.size < TARGET; t++) {
        try {
          const els = await overpass(looseFilters, randomBBox(city, 0.02), 400);
          for (const el of els) add(extract(el, city[0], false, code));
        } catch (e) { /* 跳过该轮 */ }
        await sleep(800);
      }
    }
  }

  const addrs = shuffle([...pool.values()]).slice(0, TARGET);
  const out = { code, generated: new Date().toISOString().slice(0, 10), count: addrs.length, addrs };
  fs.writeFileSync(path.join(OUT_DIR, code + '.json'), JSON.stringify(out));
  console.log(`${code} 完成: ${addrs.length} 条 -> data/pool/${code}.json`);
  return addrs.length;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const codes = process.argv.slice(2).length ? process.argv.slice(2).map(s => s.toUpperCase()) : Object.keys(COUNTRIES);
  const summary = {};
  for (const code of codes) {
    if (!COUNTRIES[code]) { console.log('未知国家代码: ' + code); continue; }
    console.log(`==== ${code} ${COUNTRIES[code].en} ====`);
    try {
      summary[code] = await buildCountry(code);
    } catch (e) {
      console.log(`${code} 失败: ${e.message}`);
      summary[code] = 0;
    }
    await sleep(1500);
  }
  console.log('\n==== 汇总 ====');
  for (const [c, n] of Object.entries(summary)) console.log(`${c}: ${n} 条${n < MIN_OK ? '  ⚠ 偏少' : ''}`);
  console.log('\n提示：重建后请运行 tools/backfill-administrative-areas.js 补齐未直接标注的州/省/地区。');
})();
