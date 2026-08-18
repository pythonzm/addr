// 从 Google libaddressinput 国家元数据推导本站使用的邮政格式与行政区配置。

function derivePostalFormat(code, format) {
  if (typeof format !== 'string' || !format.trim()) throw new Error('地址元数据缺少 fmt');

  const fields = [...format.matchAll(/%([CSZ])/g)].map(match => match[1]).filter((field, index, all) => all.indexOf(field) === index);
  const signature = fields.join('');
  const requireFields = required => {
    const missing = required.filter(field => !fields.includes(field));
    if (missing.length) throw new Error(`地址元数据缺少必要字段：${missing.map(field => `%${field}`).join('、')}`);
  };
  // 这两个国家有专用格式，但仍必须先确认元数据能提供格式化所需的字段，
  // 避免元数据异常时仅凭国家代码猜测并发布错误地址格式。
  if (code === 'BR') {
    requireFields(['C', 'S', 'Z']);
    return 'brazil';
  }
  if (code === 'JP') {
    // 日本元数据通常使用 %S 表示都道府县/市区层级，不一定包含 %C。
    requireFields(['S', 'Z']);
    return 'japan';
  }
  if (signature === 'CZ') return 'city-postcode-comma';
  if (signature === 'ZC' || signature === 'Z') return 'postcode-city';
  if (signature === 'CSZ') return format.slice(format.indexOf('%C') + 2, format.indexOf('%S')).includes(',')
    ? 'city-area-postcode-comma'
    : 'city-area-postcode';
  const formats = {
    C: 'city-postcode-comma',
    CS: 'city-area',
    SC: 'area-city',
    CZS: 'city-postcode-area',
    SCZ: 'area-city-postcode',
    SZC: 'area-postcode-city',
    ZSC: 'postcode-area-city',
    ZCS: 'postcode-city-area',
  };
  if (formats[signature]) return formats[signature];
  throw new Error(`无法识别邮政字段顺序：${signature || '无城市/行政区/邮编字段'}`);
}

function subdivisionCodes(metadata) {
  const keys = String(metadata.sub_keys || '').split('~');
  const names = String(metadata.sub_names || '').split('~');
  const latinNames = String(metadata.sub_lnames || '').split('~');
  const isoids = String(metadata.sub_isoids || '').split('~');
  const codes = {};
  keys.forEach((key, index) => {
    const code = isoids[index] || key;
    if (!code) return;
    for (const name of [names[index], latinNames[index]]) if (name) codes[name] = code;
  });
  return codes;
}

function deriveAddressProfile(code, metadata) {
  const format = metadata.fmt;
  const hasAdministrativeArea = String(format || '').includes('%S')
    || String(metadata.require || '').includes('S')
    || Boolean(metadata.state_name_type)
    || Boolean(metadata.sub_keys || metadata.sub_names || metadata.sub_lnames || metadata.sub_isoids);
  const postalFormat = derivePostalFormat(code, format);
  return {
    postalFormat,
    hasAdministrativeArea,
    administrativeAreaType: metadata.state_name_type || (hasAdministrativeArea ? 'state' : ''),
    administrativeAreaCodes: hasAdministrativeArea ? subdivisionCodes(metadata) : {},
  };
}

function parseJsonFromMirror(text) {
  const start = String(text).indexOf('{');
  const end = String(text).lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('备用地址元数据响应内容异常');
  return JSON.parse(String(text).slice(start, end + 1));
}

async function fetchAddressMetadata(iso, fetchJson, fetchRaw, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 查询参数可绕过代理/CDN 暂存的错误页；服务端会忽略它。
      return await fetchJson(`https://chromium-i18n.appspot.com/ssl-address/data/${iso}?attempt=${attempt}`);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(attempt * 1000);
    }
  }
  try {
    // Appspot 在部分服务器网络中会持续返回拦截页，使用独立的只读抓取通道兜底。
    const mirrored = await fetchRaw(`https://r.jina.ai/https://chromium-i18n.appspot.com/ssl-address/data/${iso}`);
    return parseJsonFromMirror(mirrored);
  } catch (mirrorError) {
    throw new Error(`主数据源失败：${lastError.message}；备用数据源失败：${mirrorError.message}`);
  }
}

module.exports = { derivePostalFormat, subdivisionCodes, deriveAddressProfile, parseJsonFromMirror, fetchAddressMetadata };
