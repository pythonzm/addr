const fs = require('fs');
const path = require('path');

const filename = path.join(__dirname, '..', '.cache', 'pending-country.json');

function readPendingCountry() {
  if (!fs.existsSync(filename)) return null;
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { return { code: '未知' }; }
}

function claimPendingCountry(code) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  try {
    fs.writeFileSync(filename, JSON.stringify({ code, createdAt: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function clearPendingCountry() {
  if (fs.existsSync(filename)) fs.unlinkSync(filename);
}

module.exports = { readPendingCountry, claimPendingCountry, clearPendingCountry };
