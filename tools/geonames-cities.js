const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const cacheDir = path.join(root, '.cache', 'geonames');
const citiesFile = path.join(cacheDir, 'cities500.txt');
const zipFile = path.join(cacheDir, 'cities500.zip');

function validCitiesFile() {
  try { return fs.statSync(citiesFile).size >= 1000000; }
  catch { return false; }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status || 1}`);
}

function ensureCitiesFile() {
  if (validCitiesFile()) return citiesFile;
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log('  下载 GeoNames 城市数据（后续地址池校验也会复用）…');
  run('curl', ['-fsSL', '--max-time', '300', 'https://download.geonames.org/export/dump/cities500.zip', '-o', zipFile]);
  run('unzip', ['-o', zipFile, 'cities500.txt', '-d', cacheDir]);
  fs.unlinkSync(zipFile);
  if (!validCitiesFile()) throw new Error('GeoNames 城市数据不完整');
  return citiesFile;
}

function topCitiesFromText(text, iso, count) {
  return String(text).split(/\r?\n/).filter(Boolean).map(line => line.split('\t'))
    .filter(fields => fields[8] === iso && fields[6] === 'P')
    .map(fields => ({
      name: fields[2] || fields[1],
      lat: Number(fields[4]),
      lng: Number(fields[5]),
      pop: Number(fields[14]) || 0,
    }))
    .filter(city => city.name && Number.isFinite(city.lat) && Number.isFinite(city.lng))
    .sort((a, b) => b.pop - a.pop)
    .slice(0, count);
}

function topCities(iso, count) {
  return topCitiesFromText(fs.readFileSync(ensureCitiesFile(), 'utf8'), iso, count);
}

module.exports = { ensureCitiesFile, topCitiesFromText, topCities };
