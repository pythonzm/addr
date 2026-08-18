const assert = require('assert');
const fs = require('fs');

const dataSource = fs.readFileSync(__dirname + '/js/data.js', 'utf8');
const {
  COUNTRIES,
  ADMINISTRATIVE_AREAS,
  NO_ADMINISTRATIVE_AREA_CODES,
  administrativeAreaFromAddress,
  administrativeAreaFromOsmTags,
  administrativeAreaFor,
  administrativeAreaCodeFor,
  formatAdministrativeArea,
  formatFullAddress,
} = new Function(dataSource + '; return { COUNTRIES, ADMINISTRATIVE_AREAS, NO_ADMINISTRATIVE_AREA_CODES, administrativeAreaFromAddress, administrativeAreaFromOsmTags, administrativeAreaFor, administrativeAreaCodeFor, formatAdministrativeArea, formatFullAddress };')();

for (const [code, areas] of Object.entries(ADMINISTRATIVE_AREAS)) {
  assert.strictEqual(areas.length, COUNTRIES[code].cities.length, `${code} area mapping must match cities`);
}

assert.strictEqual(administrativeAreaFor('TR', 37.906156, 32.502692), 'Konya');
assert.strictEqual(administrativeAreaFor('UK', 51.465851, -0.072612), 'England');
assert.strictEqual(administrativeAreaFor('US', 34.05, -118.26), 'California');
assert.strictEqual(administrativeAreaFor('TR', 37.9, 32.5, 'Explicit Province'), 'Explicit Province');
assert.strictEqual(administrativeAreaFor('SG', 1.32, 103.85, 'Singapore'), '');
assert.strictEqual(administrativeAreaFor('HK', 22.28, 114.16, 'Hong Kong'), '');
assert.strictEqual(administrativeAreaFor('XX', 0, 0), '');

assert.strictEqual(administrativeAreaFromAddress({ state: 'State', province: 'Province' }), 'State');
assert.strictEqual(administrativeAreaFromAddress({ province: 'Province', region: 'Region' }), 'Province');
assert.strictEqual(administrativeAreaFromAddress({ region: 'Region' }), 'Region');
assert.strictEqual(administrativeAreaFromAddress({ county: 'District' }), '');
assert.strictEqual(administrativeAreaFromOsmTags({ 'addr:state': 'Konya', 'addr:county': 'Selçuklu' }), 'Konya');
assert.strictEqual(administrativeAreaFromOsmTags({ 'addr:county': 'Selçuklu' }), '');
assert.strictEqual(administrativeAreaCodeFor('US', 'California'), 'CA');
assert.strictEqual(administrativeAreaCodeFor('CA', 'Ontario'), 'ON');
assert.strictEqual(administrativeAreaCodeFor('AU', 'New South Wales'), 'NSW');
assert.strictEqual(administrativeAreaCodeFor('US', 'Texas'), 'TX');
assert.strictEqual(administrativeAreaCodeFor('CA', 'Nova Scotia'), 'NS');
assert.strictEqual(administrativeAreaCodeFor('AU', 'Tasmania'), 'TAS');
assert.strictEqual(formatAdministrativeArea('California', 'CA'), 'California (CA)');
assert.strictEqual(formatFullAddress({ code: 'US', line1: '4444 Burns Avenue', postcode: '90029', city: 'Los Angeles', administrativeArea: 'California', administrativeAreaCode: 'CA', country: 'United States' }), '4444 Burns Avenue, Los Angeles, CA 90029, United States');
assert.strictEqual(formatFullAddress({ code: 'CA', line1: '10 Main Street', postcode: 'M5V 2T6', city: 'Toronto', administrativeArea: 'Ontario', administrativeAreaCode: 'ON', country: 'Canada' }), '10 Main Street, Toronto, ON M5V 2T6, Canada');
assert.strictEqual(formatFullAddress({ code: 'AU', line1: '10 George Street', postcode: '2000', city: 'Sydney', administrativeArea: 'New South Wales', administrativeAreaCode: 'NSW', country: 'Australia' }), '10 George Street, Sydney NSW 2000, Australia');

for (const filename of fs.readdirSync(__dirname + '/data/pool').filter(name => name.endsWith('.json'))) {
  const pool = JSON.parse(fs.readFileSync(__dirname + '/data/pool/' + filename, 'utf8'));
  for (const address of pool.addrs) {
    if (NO_ADMINISTRATIVE_AREA_CODES.has(pool.code)) {
      assert.strictEqual(address.a, undefined, `${filename} should not invent a state/province`);
      continue;
    }
    assert.ok(address.a, `${filename} ${address.o} should store an administrative area`);
    assert.ok(
      administrativeAreaFor(pool.code, address.lat, address.lng, address.a || ''),
      `${filename} ${address.o} should resolve an administrative area`,
    );
  }
}

const loadPool = code => JSON.parse(fs.readFileSync(`${__dirname}/data/pool/${code}.json`, 'utf8')).addrs;
for (const code of ['US', 'CA', 'AU']) {
  for (const area of new Set(loadPool(code).map(address => address.a))) {
    assert.ok(administrativeAreaCodeFor(code, area), `${code} ${area} should have a postal abbreviation`);
  }
}
assert.ok(loadPool('US').filter(address => ['Weehawken', 'West New York'].includes(address.c)).every(address => address.a === 'New Jersey'));
assert.ok(loadPool('TW').filter(address => address.c === '新北市').every(address => address.a === 'New Taipei City'));
// 城市标签可能本身有误；坐标位于吉隆坡的 Perai 记录应按坐标归属，而不是按远距离同名地点。
assert.ok(loadPool('MY').filter(address => address.c === 'Perai').every(address => address.a === 'Kuala Lumpur'));
assert.ok(loadPool('TR').filter(address => address.c === 'Konya').every(address => address.a === 'Konya'));
assert.ok(loadPool('CH').every(address => address.c !== 'Weil am Rhein'));
assert.ok(loadPool('JP').filter(address => address.c === '品川区').every(address => address.a === 'Tokyo'));
assert.ok(loadPool('BR').filter(address => address.c === 'Maracanã').every(address => address.a === 'Rio de Janeiro'));
assert.ok(loadPool('US').filter(address => ['Vernon', 'Silverlake'].includes(address.c)).every(address => address.a === 'California'));
assert.ok(loadPool('PH').filter(address => ['Ermita', 'Sampaloc'].includes(address.c)).every(address => address.a === 'National Capital Region'));

console.log('administrative area tests passed');
