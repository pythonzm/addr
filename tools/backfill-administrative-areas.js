// 使用 GeoNames 城市与一级行政区数据，为现有离线地址池补齐 State / Province / Region。
// 数据下载：
//   https://download.geonames.org/export/dump/cities500.zip
//   https://download.geonames.org/export/dump/admin1CodesASCII.txt
// 用法：node tools/backfill-administrative-areas.js --cities <cities500.txt> --admin1 <admin1CodesASCII.txt> [--replace] [US CA ...]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
};
const citiesFile = option('--cities');
const adminFile = option('--admin1');
const replace = args.includes('--replace');
const codes = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--cities' && args[index - 1] !== '--admin1')
  .map(code => code.toUpperCase());

if (!citiesFile || !adminFile) {
  throw new Error('必须传入 --cities cities500.txt 和 --admin1 admin1CodesASCII.txt');
}

const poolDir = path.join(__dirname, '..', 'data', 'pool');
const dataSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');
const { countryHasAdministrativeArea } = new Function(
  dataSource + '; return { countryHasAdministrativeArea };'
)();
const poolCodes = codes.length
  ? codes
  : fs.readdirSync(poolDir).filter(name => name.endsWith('.json')).map(name => path.basename(name, '.json'));
const geonamesCountry = code => code === 'UK' ? 'GB' : code;
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const areaOverrides = new Map([
  ['TW|台北市', 'Taipei City'], ['TW|臺北市', 'Taipei City'],
  ['TW|新北市', 'New Taipei City'],
  ['TW|台中市', 'Taichung City'], ['TW|臺中市', 'Taichung City'],
  ['TW|臺中市南屯區', 'Taichung City'],
  ['TW|高雄市', 'Kaohsiung City'],
]);
const gridCell = (lat, lng) => [Math.floor(lat * 4), Math.floor(lng * 4)];
const cellKey = (lat, lng) => gridCell(lat, lng).join(',');
const squaredDistance = (lat, lng, place) => {
  const latDelta = lat - place.lat;
  const lngDelta = (lng - place.lng) * Math.cos(lat * Math.PI / 180);
  return latDelta * latDelta + lngDelta * lngDelta;
};

const adminNames = new Map();
for (const line of fs.readFileSync(adminFile, 'utf8').trim().split('\n')) {
  const [key, name, asciiName] = line.split('\t');
  adminNames.set(key, asciiName || name);
}

const byCountryAndName = new Map();
const grid = new Map();
for (const line of fs.readFileSync(citiesFile, 'utf8').trim().split('\n')) {
  const fields = line.split('\t');
  const country = fields[8];
  const adminCode = fields[10];
  const area = adminNames.get(`${country}.${adminCode}`);
  if (!area) continue;
  const place = { country, area, lat: Number(fields[4]), lng: Number(fields[5]) };
  const names = new Set([fields[1], fields[2], ...(fields[3] || '').split(',')]);
  for (const name of names) {
    const key = `${country}|${normalize(name)}`;
    if (!byCountryAndName.has(key)) byCountryAndName.set(key, []);
    byCountryAndName.get(key).push(place);
  }
  const key = cellKey(place.lat, place.lng);
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(place);
}

function nearest(candidates, lat, lng) {
  let match = null;
  let distance = Infinity;
  for (const candidate of candidates || []) {
    const nextDistance = squaredDistance(lat, lng, candidate);
    if (nextDistance < distance) {
      match = candidate;
      distance = nextDistance;
    }
  }
  return { match, distance };
}

function nearbyPlaces(lat, lng) {
  const [latCell, lngCell] = gridCell(lat, lng);
  const places = [];
  for (let latOffset = -1; latOffset <= 1; latOffset++) {
    for (let lngOffset = -1; lngOffset <= 1; lngOffset++) {
      places.push(...(grid.get(`${latCell + latOffset},${lngCell + lngOffset}`) || []));
    }
  }
  return places;
}

function resolveArea(code, address) {
  const override = areaOverrides.get(`${code}|${normalize(address.c)}`);
  if (override) return { area: override, crossBorder: false };
  const country = geonamesCountry(code);
  const named = byCountryAndName.get(`${country}|${normalize(address.c)}`);
  const namedMatch = nearest(named, address.lat, address.lng);
  // 同名地点可能横跨全国；只有约 11km 内的名称匹配才优先于坐标匹配。
  if (namedMatch.match && namedMatch.distance <= 0.01) {
    return { area: namedMatch.match.area, crossBorder: false };
  }

  const nearby = nearbyPlaces(address.lat, address.lng);
  const closestOverall = nearest(nearby, address.lat, address.lng);
  // 约 5.5km 内最近的已知地点属于别国时，拒绝给跨境记录写入本国行政区。
  if (closestOverall.match && closestOverall.match.country !== country && closestOverall.distance < 0.0025) {
    return { area: '', crossBorder: true };
  }
  return {
    area: nearest(nearby.filter(place => place.country === country), address.lat, address.lng).match?.area || '',
    crossBorder: false,
  };
}

let totalUpdated = 0;
let totalUnresolved = 0;
for (const code of poolCodes) {
  const filename = path.join(poolDir, `${code}.json`);
  const pool = JSON.parse(fs.readFileSync(filename, 'utf8'));
  let updated = 0;
  let unresolved = 0;
  let removed = 0;
  const addrs = [];
  for (const address of pool.addrs || []) {
    // Hong Kong 和 Singapore 没有供国际地址表单填写的州/省层级。
    if (!countryHasAdministrativeArea(code)) {
      delete address.a;
      delete address.as;
      addrs.push(address);
      continue;
    }
    if (address.a && !replace) {
      addrs.push(address);
      continue;
    }
    const { area, crossBorder } = resolveArea(code, address);
    if (crossBorder) {
      removed++;
      continue;
    }
    if (area) {
      address.a = area;
      address.as = 'geonames';
      updated++;
    } else {
      delete address.a;
      delete address.as;
      unresolved++;
    }
    addrs.push(address);
  }
  pool.addrs = addrs;
  pool.count = addrs.length;
  fs.writeFileSync(filename, JSON.stringify(pool));
  totalUpdated += updated;
  totalUnresolved += unresolved;
  console.log(`${code}: 补齐 ${updated} 条，移除跨境 ${removed} 条，未解析 ${unresolved} 条`);
}
console.log(`完成：补齐 ${totalUpdated} 条，未解析 ${totalUnresolved} 条`);
if (totalUnresolved) process.exitCode = 1;
