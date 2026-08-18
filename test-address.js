const assert = require('assert');
const fs = require('fs');

const dataSource = fs.readFileSync(__dirname + '/js/data.js', 'utf8');
const {
  COUNTRIES,
  ADMINISTRATIVE_AREAS,
  administrativeAreaFromAddress,
  administrativeAreaFromOsmTags,
  administrativeAreaFor,
} = new Function(dataSource + '; return { COUNTRIES, ADMINISTRATIVE_AREAS, administrativeAreaFromAddress, administrativeAreaFromOsmTags, administrativeAreaFor };')();

for (const [code, areas] of Object.entries(ADMINISTRATIVE_AREAS)) {
  assert.strictEqual(areas.length, COUNTRIES[code].cities.length, `${code} area mapping must match cities`);
}

assert.strictEqual(administrativeAreaFor('TR', 37.906156, 32.502692), 'Konya');
assert.strictEqual(administrativeAreaFor('UK', 51.465851, -0.072612), 'England');
assert.strictEqual(administrativeAreaFor('US', 34.05, -118.26), 'California');
assert.strictEqual(administrativeAreaFor('TR', 37.9, 32.5, 'Explicit Province'), 'Explicit Province');
assert.strictEqual(administrativeAreaFor('XX', 0, 0), '');

assert.strictEqual(administrativeAreaFromAddress({ state: 'State', province: 'Province' }), 'State');
assert.strictEqual(administrativeAreaFromAddress({ province: 'Province', region: 'Region' }), 'Province');
assert.strictEqual(administrativeAreaFromAddress({ region: 'Region' }), 'Region');
assert.strictEqual(administrativeAreaFromAddress({ county: 'District' }), '');
assert.strictEqual(administrativeAreaFromOsmTags({ 'addr:state': 'Konya', 'addr:county': 'Selçuklu' }), 'Konya');
assert.strictEqual(administrativeAreaFromOsmTags({ 'addr:county': 'Selçuklu' }), '');

for (const filename of fs.readdirSync(__dirname + '/data/pool').filter(name => name.endsWith('.json'))) {
  const pool = JSON.parse(fs.readFileSync(__dirname + '/data/pool/' + filename, 'utf8'));
  for (const address of pool.addrs) {
    assert.ok(
      administrativeAreaFor(pool.code, address.lat, address.lng, address.a || ''),
      `${filename} ${address.o} should resolve an administrative area`,
    );
  }
}

console.log('administrative area tests passed');
