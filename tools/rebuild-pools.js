// 后台专用的完整建池流程：OSM 建池 → GeoNames 行政区补全 → 数据校验。
// 用法：node tools/rebuild-pools.js [US CA ...]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readPendingCountry, clearPendingCountry } = require('./country-pending');

const root = path.join(__dirname, '..');
const cacheDir = path.join(root, '.cache', 'geonames');
const citiesFile = path.join(cacheDir, 'cities500.txt');
const adminFile = path.join(cacheDir, 'admin1CodesASCII.txt');
const zipFile = path.join(cacheDir, 'cities500.zip');
const codes = process.argv.slice(2).map(code => code.toUpperCase());

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function validFile(filename, minimumBytes) {
  try { return fs.statSync(filename).size >= minimumBytes; }
  catch { return false; }
}

function ensureGeoNames() {
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!validFile(adminFile, 10000)) {
    console.log('下载 GeoNames 一级行政区数据…');
    run('curl', ['-fsSL', '--max-time', '300', 'https://download.geonames.org/export/dump/admin1CodesASCII.txt', '-o', adminFile]);
  }
  if (!validFile(citiesFile, 1000000)) {
    console.log('下载并解压 GeoNames 城市数据…');
    run('curl', ['-fsSL', '--max-time', '300', 'https://download.geonames.org/export/dump/cities500.zip', '-o', zipFile]);
    run('unzip', ['-o', zipFile, 'cities500.txt', '-d', cacheDir]);
    fs.unlinkSync(zipFile);
  }
}

ensureGeoNames();
run(process.execPath, [path.join('tools', 'build-pool.js'), ...codes]);
run(process.execPath, [
  path.join('tools', 'backfill-administrative-areas.js'),
  '--cities', citiesFile,
  '--admin1', adminFile,
  ...codes,
]);
run(process.execPath, ['test-address.js']);
const pending = readPendingCountry();
if (pending && (!codes.length || codes.includes(pending.code))) clearPendingCountry();
console.log('完整建池流程通过，可以发布。');
