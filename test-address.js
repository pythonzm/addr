const assert = require('assert');
const fs = require('fs');
const { deriveAddressProfile, fetchAddressMetadata } = require('./tools/address-metadata');
const { topCitiesFromText } = require('./tools/geonames-cities');

const dataSource = fs.readFileSync(__dirname + '/js/data.js', 'utf8');
const {
  COUNTRIES,
  POSTAL_FORMATS,
  POOL_MIN_PUBLISH,
  ADMINISTRATIVE_AREAS,
  ADMINISTRATIVE_AREA_CODES,
  countryHasAdministrativeArea,
  administrativeAreaFromAddress,
  administrativeAreaFromOsmTags,
  administrativeAreaFor,
  administrativeAreaCodeFor,
  formatAdministrativeArea,
  administrativeAreasEquivalent,
  postalFormatForCountry,
  formatFullAddress,
} = new Function(dataSource + '; return { COUNTRIES, POSTAL_FORMATS, POOL_MIN_PUBLISH, ADMINISTRATIVE_AREAS, ADMINISTRATIVE_AREA_CODES, countryHasAdministrativeArea, administrativeAreaFromAddress, administrativeAreaFromOsmTags, administrativeAreaFor, administrativeAreaCodeFor, formatAdministrativeArea, administrativeAreasEquivalent, postalFormatForCountry, formatFullAddress };')();

const metadataCases = [
  ['US', { fmt: '%N%n%O%n%A%n%C, %S %Z', require: 'ACSZ', sub_keys: 'CA~NY', sub_names: 'California~New York', sub_isoids: 'CA~NY' }, 'city-area-postcode-comma', true],
  ['GB', { fmt: '%N%n%O%n%A%n%C%n%Z', require: 'ACZ' }, 'city-postcode-comma', false],
  ['DE', { fmt: '%N%n%O%n%A%n%Z %C', require: 'ACZ' }, 'postcode-city', false],
  ['BR', { fmt: '%O%n%N%n%A%n%D%n%C-%S%n%Z', require: 'ASCZ' }, 'brazil', true],
  ['JP', { fmt: '〒%Z%n%S%n%A%n%O%n%N', require: 'ASZ' }, 'japan', true],
  ['SG', { fmt: '%N%n%O%n%A%nSINGAPORE %Z', require: 'AZ' }, 'postcode-city', false],
  ['HK', { fmt: '%S%n%C%n%D%n%A%n%O%n%N', require: 'AS' }, 'area-city', true],
  ['TR', { fmt: '%N%n%O%n%A%n%Z %C/%S', require: 'ACZ' }, 'postcode-city-area', true],
  ['KR', { fmt: '%S %C%D%n%A%n%O%n%N%n%Z', require: 'ACSZ' }, 'area-city-postcode', true],
  ['TW', { fmt: '%Z%n%S%C%n%A%n%O%n%N', require: 'ACSZ' }, 'postcode-area-city', true],
];
for (const [code, metadata, postalFormat, hasAdministrativeArea] of metadataCases) {
  const profile = deriveAddressProfile(code, metadata);
  assert.strictEqual(profile.postalFormat, postalFormat, `${code} postal format`);
  assert.strictEqual(profile.hasAdministrativeArea, hasAdministrativeArea, `${code} administrative area`);
}
assert.strictEqual(deriveAddressProfile('US', metadataCases[0][1]).administrativeAreaCodes.California, 'CA');
assert.strictEqual(deriveAddressProfile('XX', { fmt: '%C %Z %S' }).postalFormat, 'city-postcode-area');
assert.strictEqual(deriveAddressProfile('XX', { fmt: '%S %Z %C' }).postalFormat, 'area-postcode-city');
assert.strictEqual(deriveAddressProfile('XX', { fmt: '%C%n%Z', sub_keys: 'North~South' }).hasAdministrativeArea, true);
assert.throws(() => deriveAddressProfile('XX', { fmt: '%A%n%N' }), /无法识别邮政字段顺序/);
assert.throws(() => deriveAddressProfile('BR', { fmt: '%A%n%N' }), /缺少必要字段/);
assert.throws(() => deriveAddressProfile('JP', { fmt: '%A%n%N' }), /缺少必要字段/);

(async () => {
  const requested = [];
  const metadata = await fetchAddressMetadata('ID', async url => {
    requested.push(url);
    throw new Error('响应内容异常');
  }, async url => {
    requested.push(url);
    return 'Title:\n\nMarkdown Content:\n{"fmt":"%C%n%S %Z"}\n';
  }, async () => {});
  assert.strictEqual(metadata.fmt, '%C%n%S %Z');
  assert.strictEqual(requested.length, 4);
  assert.ok(requested.slice(0, 3).every((url, index) => url.endsWith(`ID?attempt=${index + 1}`)));
  assert.ok(requested[3].startsWith('https://r.jina.ai/'));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const geoNamesFixture = [
  ['1', 'Jakarta', 'Jakarta', '', '-6.21462', '106.84513', 'P', 'PPLC', 'ID', '', '04', '', '', '', '8540121'].join('\t'),
  ['2', 'Surabaya', 'Surabaya', '', '-7.24917', '112.75083', 'P', 'PPLA', 'ID', '', '08', '', '', '', '2874314'].join('\t'),
  ['3', 'Bandung', 'Bandung', '', '-6.92222', '107.60694', 'P', 'PPLA', 'ID', '', '30', '', '', '', '2441600'].join('\t'),
  ['4', 'Singapore', 'Singapore', '', '1.28967', '103.85007', 'P', 'PPLC', 'SG', '', '', '', '', '', '5638700'].join('\t'),
].join('\n');
assert.deepStrictEqual(topCitiesFromText(geoNamesFixture, 'ID', 2).map(city => city.name), ['Jakarta', 'Surabaya']);

for (const [code, areas] of Object.entries(ADMINISTRATIVE_AREAS)) {
  assert.strictEqual(areas.length, COUNTRIES[code].cities.length, `${code} area mapping must match cities`);
}

assert.strictEqual(administrativeAreaFor('TR', 37.906156, 32.502692), 'Konya');
assert.strictEqual(administrativeAreaFor('UK', 51.465851, -0.072612), 'England');
assert.strictEqual(administrativeAreaFor('US', 34.05, -118.26), 'California');
assert.strictEqual(administrativeAreaFor('TR', 37.9, 32.5, 'Explicit Province'), 'Explicit Province');
assert.strictEqual(administrativeAreaFor('SG', 1.32, 103.85, 'Singapore'), '');
assert.strictEqual(administrativeAreaFor('HK', 22.28, 114.16, 'Hong Kong'), '');
assert.strictEqual(formatFullAddress({ code: 'SG', line1: '1 Test Road', postcode: '123456', city: 'Singapore', administrativeArea: 'Invented', administrativeAreaCode: 'ST', country: 'Singapore' }), '1 Test Road, 123456 Singapore, Singapore');
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
assert.strictEqual(administrativeAreaCodeFor('BR', 'Sao Paulo'), 'SP');
assert.strictEqual(administrativeAreaCodeFor('BR', 'Paraná'), 'PR');
assert.strictEqual(Object.values(ADMINISTRATIVE_AREA_CODES.BR).filter((code, index, codes) => codes.indexOf(code) === index).length, 27);
assert.ok(administrativeAreasEquivalent('KR', '서울특별시', 'Seoul'));
assert.ok(administrativeAreasEquivalent('TW', '臺中市南屯區', 'Taichung City'));
assert.ok(administrativeAreasEquivalent('TR', 'Selçuklu/Konya', 'Konya'));
assert.strictEqual(formatAdministrativeArea('California', 'CA'), 'California (CA)');
assert.strictEqual(formatFullAddress({ code: 'US', line1: '4444 Burns Avenue', postcode: '90029', city: 'Los Angeles', administrativeArea: 'California', administrativeAreaCode: 'CA', country: 'United States' }), '4444 Burns Avenue, Los Angeles, CA 90029, United States');
assert.strictEqual(formatFullAddress({ code: 'CA', line1: '10 Main Street', postcode: 'M5V 2T6', city: 'Toronto', administrativeArea: 'Ontario', administrativeAreaCode: 'ON', country: 'Canada' }), '10 Main Street, Toronto, ON M5V 2T6, Canada');
assert.strictEqual(formatFullAddress({ code: 'AU', line1: '10 George Street', postcode: '2000', city: 'Sydney', administrativeArea: 'New South Wales', administrativeAreaCode: 'NSW', country: 'Australia' }), '10 George Street, Sydney NSW 2000, Australia');
assert.strictEqual(formatFullAddress({ code: 'BR', line1: 'Avenida Paulista, 100', postcode: '01310-100', city: 'São Paulo', administrativeArea: 'Sao Paulo', administrativeAreaCode: 'SP', country: 'Brazil' }), 'Avenida Paulista, 100, São Paulo - SP, 01310-100, Brazil');
assert.strictEqual(formatFullAddress({ code: 'JP', line1: '千代田1', postcode: '100-0001', city: '千代田区', administrativeArea: 'Tokyo', administrativeAreaCode: '', country: 'Japan' }), '千代田1, 〒100-0001 Tokyo 千代田区, Japan');
assert.strictEqual(formatFullAddress({ code: 'KR', line1: '테헤란로 1', postcode: '06236', city: '서울특별시', administrativeArea: 'Seoul', administrativeAreaCode: '', country: 'South Korea' }), '테헤란로 1, 06236 서울특별시, South Korea');
assert.strictEqual(formatFullAddress({ code: 'TW', line1: '信義路 1 號', postcode: '100', city: '台北市', administrativeArea: 'Taipei City', administrativeAreaCode: '', country: 'Taiwan' }), '信義路 1 號, 100 台北市, Taiwan');
assert.strictEqual(formatFullAddress({ code: 'TR', line1: 'Zakkum Sokak 4', postcode: '42110', city: 'Selçuklu/Konya', administrativeArea: 'Konya', administrativeAreaCode: '', country: 'Türkiye' }), 'Zakkum Sokak 4, 42110 Selçuklu/Konya, Türkiye');
assert.strictEqual(formatFullAddress({ code: 'TR', line1: 'Zakkum Sokak 4', postcode: '42110', city: 'Konya', administrativeArea: 'Konya', administrativeAreaCode: '', country: 'Türkiye' }), 'Zakkum Sokak 4, 42110 Konya, Türkiye');
assert.strictEqual(formatFullAddress({ code: 'UK', line1: '20B Maxted Road', postcode: 'SE15 4LF', city: 'London', administrativeArea: 'England', administrativeAreaCode: '', country: 'United Kingdom' }), '20B Maxted Road, London, SE15 4LF, United Kingdom');
assert.strictEqual(postalFormatForCountry('DE'), 'postcode-city');
assert.strictEqual(postalFormatForCountry('UK'), 'city-postcode-comma');
assert.ok(Object.keys(POSTAL_FORMATS).includes(postalFormatForCountry('DE')));
COUNTRIES.ZZ = { postalFormat: 'city-postcode-comma' };
assert.strictEqual(formatFullAddress({ code: 'ZZ', line1: '1 Test Road', postcode: '12345', city: 'Example', administrativeArea: '', administrativeAreaCode: '', country: 'Testland' }), '1 Test Road, Example, 12345, Testland');
COUNTRIES.ZZ = { postalFormat: 'city-postcode-area' };
assert.strictEqual(formatFullAddress({ code: 'ZZ', line1: '1 Test Road', postcode: '12345', city: 'Example', administrativeArea: 'North', country: 'Testland' }), '1 Test Road, Example 12345 North, Testland');
COUNTRIES.ZZ = { postalFormat: 'area-postcode-city' };
assert.strictEqual(formatFullAddress({ code: 'ZZ', line1: '1 Test Road', postcode: '12345', city: 'Example', administrativeArea: 'North', country: 'Testland' }), '1 Test Road, North 12345 Example, Testland');
COUNTRIES.ZZ = { postalFormat: 'postcode-city', noAdministrativeArea: true };
assert.strictEqual(countryHasAdministrativeArea('ZZ'), false);
assert.strictEqual(administrativeAreaFor('ZZ', 1, 1, 'Invented State'), '');
COUNTRIES.ZZ = { postalFormat: 'typo' };
assert.throws(() => formatFullAddress({ code: 'ZZ', line1: '1 Test Road', postcode: '12345', city: 'Example', country: 'Testland' }), /Unknown postal format/);
delete COUNTRIES.ZZ;

for (const filename of fs.readdirSync(__dirname + '/data/pool').filter(name => name.endsWith('.json'))) {
  const pool = JSON.parse(fs.readFileSync(__dirname + '/data/pool/' + filename, 'utf8'));
  for (const address of pool.addrs) {
    if (!countryHasAdministrativeArea(pool.code)) {
      assert.strictEqual(address.a, undefined, `${filename} should not invent a state/province`);
      continue;
    }
    assert.ok(address.a, `${filename} ${address.o} should store an administrative area`);
    assert.ok(
      administrativeAreaFor(pool.code, address.lat, address.lng, address.a || ''),
      `${filename} ${address.o} should resolve an administrative area`,
    );
  }
  assert.strictEqual(pool.count, pool.addrs.length, `${filename} count should match addrs length`);
  assert.ok(pool.count >= POOL_MIN_PUBLISH, `${filename} should meet the publish threshold`);
}
for (const code of Object.keys(COUNTRIES)) {
  assert.ok(fs.existsSync(`${__dirname}/data/pool/${code}.json`), `${code} should have a validated address pool`);
}

const loadPool = code => JSON.parse(fs.readFileSync(`${__dirname}/data/pool/${code}.json`, 'utf8')).addrs;
for (const code of ['US', 'CA', 'AU', 'BR']) {
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
