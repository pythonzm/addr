// 临时端到端测试：模拟 app.js 的随机取址流程（不涉及 DOM）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/js/data.js', 'utf8');
eval(src.replace(/^const /gm, 'globalThis.').replace(/^globalThis (COUNTRIES|EMAIL_DOMAINS)/gm, 'globalThis.$1'));

const pick = a => a[Math.floor(Math.random() * a.length)];
function randomBBox(city, half) {
  const [, clat, clng, r] = city;
  const ang = Math.random() * Math.PI * 2;
  const dist = Math.sqrt(Math.random()) * r;
  const lat = clat + Math.sin(ang) * dist;
  const lng = clng + Math.cos(ang) * dist / Math.cos(clat * Math.PI / 180);
  return `${lat - half},${lng - half},${lat + half},${lng + half}`;
}
async function overpass(bbox, limit) {
  const q = `[out:json][timeout:25];(node["addr:housenumber"](${bbox});way["addr:housenumber"](${bbox}););out tags center ${limit};`;
  const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  let lastErr;
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'addr-generator-e2e-test/1.0' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements || [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function test(code) {
  const c = COUNTRIES[code];
  for (let attempt = 0; attempt < 5; attempt++) {
    const city = pick(c.cities);
    const half = attempt < 3 ? 0.01 : 0.03;
    const els = await overpass(randomBBox(city, half), attempt < 3 ? 80 : 150);
    const t = el => el.tags || {};
    const A = els.filter(el => t(el)['addr:street'] && t(el)['addr:postcode'] && t(el)['addr:city']);
    const B = els.filter(el => t(el)['addr:street']);
    const found = A.length ? A : B.length ? B : els;
    if (found.length) {
      const el = pick(found), tg = el.tags;
      console.log(`${code} [尝试${attempt + 1}, ${city[0]}, tier ${A.length ? 'A' : B.length ? 'B' : 'C'}]: ${tg['addr:street'] || tg['addr:place'] || '?'} ${tg['addr:housenumber']}, ${tg['addr:postcode'] || '?'} ${tg['addr:city'] || '?'}  => osm.org/${el.type}/${el.id}`);
      return true;
    }
  }
  console.log(code + ': 5 次尝试均未取到');
  return false;
}
(async () => {
  for (const code of ['KR', 'TW', 'SG', 'BR']) {
    try { await test(code); } catch (e) { console.log(code + ' ERROR: ' + e.message); }
    await new Promise(r => setTimeout(r, 1200));
  }
})();
