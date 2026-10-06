/*
 * core.js — everything that is not the screen.
 *
 * Login crypto, the Sunsynk and Open-Meteo calls, and the rules for turning their
 * answers into numbers worth showing. No DOM in here, so the tests can run the
 * real code in Node rather than a copy of it.
 *
 * Exposed as `SolarCore` on the global object (browser) and as module.exports (Node).
 */
(function (root) {
  'use strict';

  const API = 'https://api.sunsynk.net';
  const SOURCE = 'sunsynk';
  const CLIENT_ID = 'csp-web';

  // Sunsynk's cloud refreshes roughly every 5 minutes; asking harder buys nothing
  // and risks the account being throttled.
  const POLL_MS = 2 * 60 * 1000;
  const TOTALS_EVERY_N_POLLS = 3;          // daily kWh totals move slowly
  const WEATHER_MS = 30 * 60 * 1000;
  const STALE_AFTER_MS = 10 * 60 * 1000;   // amber dot past this
  // The inverter uploads every few minutes. Past this, Sunsynk is answering but the
  // inverter itself has gone quiet (Wi-Fi dongle, router, power) and its live numbers
  // come back as zeros that must not be shown as real readings.
  const SYSTEM_SILENT_MS = 20 * 60 * 1000;
  const RETRY_DELAYS_MS = [60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];
  const TOKEN_MARGIN_MS = 5 * 60 * 1000;   // log in again a little before expiry
  const PERFORMANCE_RATIO = 0.75;          // panels never deliver nameplate × irradiance

  // Weather location until the system's own coordinates arrive: 49 Buitekant Street, Oudtshoorn.
  const DEFAULT_LOCATION = { lat: -33.5947, lon: 22.1927, label: 'Oudtshoorn', source: 'default' };

  // ---------------------------------------------------------------- bytes

  function utf8(str) {
    return new TextEncoder().encode(String(str));
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function bytesToBigInt(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex ? BigInt('0x' + hex) : 0n;
  }

  function bigIntToBytes(x, length) {
    let hex = x.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    if (hex.length / 2 > length) throw new Error('number does not fit in ' + length + ' bytes');
    hex = hex.padStart(length * 2, '0');
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // ---------------------------------------------------------------- MD5
  // The browser's crypto has no MD5, and Sunsynk signs every login request with it.

  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const MD5_K = (function () {
    const k = new Int32Array(64);
    for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    return k;
  })();

  function md5(str) {
    const bytes = utf8(str);
    const len = bytes.length;
    const blocks = ((len + 8) >>> 6) + 1;
    const w = new Int32Array(blocks * 16);
    for (let i = 0; i < len; i++) w[i >>> 2] |= bytes[i] << ((i % 4) * 8);
    w[len >>> 2] |= 0x80 << ((len % 4) * 8);
    w[blocks * 16 - 2] = (len * 8) >>> 0;
    w[blocks * 16 - 1] = Math.floor(len / 0x20000000);

    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let blk = 0; blk < blocks; blk++) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + w[blk * 16 + g]) | 0;
        A = D; D = C; C = B;
        B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    let hex = '';
    for (const v of [a0, b0, c0, d0]) {
      for (let j = 0; j < 4; j++) hex += ((v >>> (j * 8)) & 0xff).toString(16).padStart(2, '0');
    }
    return hex;
  }

  // ---------------------------------------------------------------- RSA (PKCS#1 v1.5)
  // The browser's crypto only offers RSA-OAEP; Sunsynk wants PKCS#1 v1.5.

  function cleanKey(key) {
    return String(key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  }

  function tlv(b, p) {
    const tag = b[p];
    let len = b[p + 1];
    let q = p + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[q++];
    }
    if (q + len > b.length) throw new Error('public key is truncated');
    return { tag, start: q, end: q + len };
  }

  // Accepts SubjectPublicKeyInfo (what Sunsynk sends) and bare PKCS#1 RSAPublicKey.
  function parseRsaPublicKey(der) {
    const outer = tlv(der, 0);
    if (outer.tag !== 0x30) throw new Error('public key is not a DER SEQUENCE');
    let rsa = outer;
    const first = tlv(der, outer.start);
    if (first.tag === 0x30) {
      const bits = tlv(der, first.end);
      if (bits.tag !== 0x03) throw new Error('public key has no BIT STRING');
      rsa = tlv(der, bits.start + 1);           // skip the unused-bits byte
      if (rsa.tag !== 0x30) throw new Error('public key BIT STRING is not RSA');
    }
    const nT = tlv(der, rsa.start);
    const eT = tlv(der, nT.end);
    if (nT.tag !== 0x02 || eT.tag !== 0x02) throw new Error('public key is missing its modulus or exponent');
    const n = bytesToBigInt(der.subarray(nT.start, nT.end));
    const e = bytesToBigInt(der.subarray(eT.start, eT.end));
    const k = Math.ceil(n.toString(16).length / 2);
    return { n, e, k };
  }

  function modPow(base, exp, mod) {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod;
      base = (base * base) % mod;
      exp >>= 1n;
    }
    return result;
  }

  function defaultRandom(n) {
    const out = new Uint8Array(n);
    root.crypto.getRandomValues(out);
    return out;
  }

  function rsaPkcs1Encrypt(publicKey, text, randomBytes) {
    const rand = randomBytes || defaultRandom;
    const { n, e, k } = parseRsaPublicKey(b64ToBytes(cleanKey(publicKey)));
    const m = utf8(text);
    if (m.length > k - 11) throw new Error('password is too long for the key');
    const psLen = k - 3 - m.length;
    const ps = rand(psLen);
    for (let i = 0; i < psLen; i++) {
      while (ps[i] === 0) ps[i] = rand(1)[0];   // padding bytes must be non-zero
    }
    const em = new Uint8Array(k);
    em[1] = 0x02;
    em.set(ps, 2);
    em[2 + psLen] = 0x00;
    em.set(m, 3 + psLen);
    const c = modPow(bytesToBigInt(em), e, n);
    return bytesToB64(bigIntToBytes(c, k));
  }

  // ---------------------------------------------------------------- Sunsynk login

  function publicKeySign(nonce) {
    return md5('nonce=' + nonce + '&source=' + SOURCE + 'POWER_VIEW');
  }

  function tokenSign(nonce, publicKey) {
    return md5('nonce=' + nonce + '&source=' + SOURCE + String(publicKey).slice(0, 10));
  }

  // kind: 'auth'    — the credentials were refused; retrying will not help.
  //       'expired' — the token stopped working; log in again once.
  //       'network' — could not reach the server, or it failed; retry later.
  //       'server'  — the server answered but refused the request.
  class SunsynkError extends Error {
    constructor(message, kind, detail) {
      super(message);
      this.name = 'SunsynkError';
      this.kind = kind;
      this.detail = detail;
    }
  }

  async function requestJson(fetchFn, url, options) {
    let res;
    try {
      res = await fetchFn(url, options);
    } catch (e) {
      throw new SunsynkError('Could not reach Sunsynk (' + (e && e.message || 'network error') + ')', 'network');
    }
    if (res.status === 401) throw new SunsynkError('Sunsynk session expired', 'expired');
    if (!res.ok) throw new SunsynkError('Sunsynk answered HTTP ' + res.status, 'network');
    try {
      return await res.json();
    } catch (e) {
      throw new SunsynkError('Sunsynk sent something that is not JSON', 'network');
    }
  }

  async function login(fetchFn, username, password, nowFn) {
    const now = nowFn || Date.now;
    if (!username || !password) throw new SunsynkError('Enter the Sunsynk email and password', 'auth');

    const n1 = now();
    const pk = await requestJson(fetchFn,
      API + '/anonymous/publicKey?source=' + SOURCE + '&nonce=' + n1 + '&sign=' + publicKeySign(n1),
      { method: 'GET' });
    const key = pk && pk.code === 0
      ? (typeof pk.data === 'string' ? pk.data : (pk.data && (pk.data.publicKey || pk.data.key)))
      : null;
    if (!key) {
      throw new SunsynkError('Sunsynk did not supply a login key' + (pk && pk.msg ? ' (' + pk.msg + ')' : ''), 'server', pk);
    }

    const n2 = now();
    const body = {
      client_id: CLIENT_ID,
      grant_type: 'password',
      password: rsaPkcs1Encrypt(key, password),
      source: SOURCE,
      username: username,
      nonce: n2,
      sign: tokenSign(n2, key.trim()),
    };
    const tok = await requestJson(fetchFn, API + '/oauth/token/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = tok && tok.data;
    if (!tok || tok.code !== 0 || !data || !data.access_token) {
      throw new SunsynkError((tok && tok.msg) || 'Sunsynk refused the login', 'auth', tok && { code: tok.code, msg: tok.msg });
    }
    const lifeMs = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
    return {
      accessToken: data.access_token,
      expiresAt: now() + Math.max(lifeMs - TOKEN_MARGIN_MS, 60 * 1000),
    };
  }

  async function authedGet(fetchFn, accessToken, path) {
    const j = await requestJson(fetchFn, API + path, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!j || j.code !== 0) {
      throw new SunsynkError('Sunsynk refused a data request' + (j && j.msg ? ' (' + j.msg + ')' : ''), 'server', j);
    }
    return j.data;
  }

  // A Sunsynk session: logs in when it has to, and once more if a token dies early.
  // Storage is injected so the tests can drive it without a browser.
  function createSession(opts) {
    const fetchFn = opts.fetchFn;
    const now = opts.nowFn || Date.now;
    let token = opts.loadToken ? opts.loadToken() : null;

    async function ensureToken(force) {
      if (!force && token && token.accessToken && token.expiresAt > now()) return token.accessToken;
      const creds = opts.getCreds();
      if (!creds) throw new SunsynkError('Not signed in', 'auth');
      token = await login(fetchFn, creds.username, creds.password, now);
      if (opts.saveToken) opts.saveToken(token);
      return token.accessToken;
    }

    async function get(path) {
      const t = await ensureToken(false);
      try {
        return await authedGet(fetchFn, t, path);
      } catch (e) {
        if (e.kind !== 'expired') throw e;
        const t2 = await ensureToken(true);
        return authedGet(fetchFn, t2, path);
      }
    }

    function forget() {
      token = null;
      if (opts.saveToken) opts.saveToken(null);
    }

    return { get, ensureToken, forget };
  }

  // What to do after a failed poll. A refused login must NOT be retried on a timer:
  // repeated bad logins can lock the owner out of their own Sunsynk account.
  function decideAfterError(err, failCount) {
    if (err && err.kind === 'auth') return { action: 'setup', delayMs: null };
    return { action: 'retry', delayMs: retryDelay(failCount) };
  }

  function retryDelay(failCount) {
    const i = Math.max(0, Math.min(RETRY_DELAYS_MS.length - 1, (failCount || 1) - 1));
    return RETRY_DELAYS_MS[i];
  }

  // ---------------------------------------------------------------- Sunsynk paths

  function localDate(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  const paths = {
    plants: () => '/api/v1/plants?page=1&limit=20&name=&status=',
    plantDetail: (plantId) => '/api/v1/plant/' + encodeURIComponent(plantId) + '?lan=en&id=' + encodeURIComponent(plantId),
    inverter: (sn) => '/api/v1/inverter/' + encodeURIComponent(sn),
    inverters: (plantId) => '/api/v1/plant/' + encodeURIComponent(plantId) + '/inverters?page=1&limit=20&status=-1&sn=&id=' + encodeURIComponent(plantId) + '&type=-2',
    flow: (plantId, date) => '/api/v1/plant/energy/' + encodeURIComponent(plantId) + '/flow?date=' + (date || localDate()),
    pvInput: (sn) => '/api/v1/inverter/' + encodeURIComponent(sn) + '/realtime/input',
    battery: (sn) => '/api/v1/inverter/battery/' + encodeURIComponent(sn) + '/realtime?sn=' + encodeURIComponent(sn) + '&lan=en',
    grid: (sn) => '/api/v1/inverter/grid/' + encodeURIComponent(sn) + '/realtime?sn=' + encodeURIComponent(sn),
    load: (sn) => '/api/v1/inverter/load/' + encodeURIComponent(sn) + '/realtime?sn=' + encodeURIComponent(sn),
  };

  // ---------------------------------------------------------------- normalising

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function pick(obj) {
    if (!obj) return null;
    for (let i = 1; i < arguments.length; i++) {
      const v = num(obj[arguments[i]]);
      if (v !== null) return v;
    }
    return null;
  }

  function listOf(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.infos || data.list || data.records || [];
  }

  function normalizePlants(data) {
    return listOf(data).map((p) => ({
      id: p.id,
      name: p.name || ('Plant ' + p.id),
      kWp: pick(p, 'totalPower', 'capacity', 'installedCapacity'),
      updatedAt: p.updateAt || p.updatedAt || null,
    })).filter((p) => p.id !== undefined && p.id !== null);
  }

  function firstInverterSn(data) {
    const inv = listOf(data).find((i) => i && i.sn);
    return inv ? String(inv.sn) : null;
  }

  // Sunsynk timestamps are ISO with a zone ("2026-10-06T00:31:27Z"). Anything without
  // a zone is refused rather than guessed, because a two-hour error would make a
  // working inverter look silent (or a silent one look fine).
  function parseTime(s) {
    if (typeof s !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s.trim())) return null;
    const t = Date.parse(s.trim());
    return Number.isFinite(t) ? t : null;
  }

  // When the inverter last uploaded anything.
  function inverterReportedAt(inv) {
    return inv ? parseTime(inv.updateAt) : null;
  }

  function townFromAddress(address) {
    if (!address) return null;
    const parts = String(address).split(',').map((p) => p.trim()).filter(Boolean);
    const town = parts.slice(1).find((p) => /[a-z]/i.test(p) && !/\d/.test(p) && !/south africa/i.test(p));
    return town || null;
  }

  function normalizePlantDetail(d) {
    if (!d) return null;
    const lat = num(d.lat), lon = num(d.lon);
    const hasPlace = lat !== null && lon !== null && !(lat === 0 && lon === 0);
    return {
      name: d.name || null,
      kWp: pick(d, 'totalPower') ?? pick(d.realtime, 'totalPower'),
      lat: hasPlace ? lat : null,
      lon: hasPlace ? lon : null,
      town: townFromAddress(d.address),
      reportedAt: parseTime(d.realtime && d.realtime.updateAt) ?? parseTime(d.updateAt),
      realtime: d.realtime || null,
    };
  }

  // Contact details have no place in a diagnostics screenshot someone might send on.
  function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = /^(email|phone|principal|installer|master|user|thumbUrl)$/i.test(k) && v !== null ? '(hidden)' : redact(v);
      }
      return out;
    }
    return value;
  }

  // Sunsynk reports magnitudes plus direction flags. Signed results, from the
  // house's point of view:
  //   batteryW > 0 charging,  < 0 discharging
  //   gridW    > 0 importing, < 0 exporting
  function normalizeFlow(d) {
    if (!d) return null;
    const pvW = Math.abs(pick(d, 'pvPower') || 0);
    const loadW = Math.abs(pick(d, 'loadOrEpsPower', 'loadPower', 'homeLoadPower') || 0);

    const battRaw = pick(d, 'battPower', 'batteryPower') || 0;
    let batteryW;
    if (d.toBat === true) batteryW = Math.abs(battRaw);
    else if (d.batTo === true) batteryW = -Math.abs(battRaw);
    else if (d.toBat === false && d.batTo === false) batteryW = 0;
    else batteryW = -battRaw;                 // no flags: Sunsynk's sign is + discharging

    const gridRaw = pick(d, 'gridOrMeterPower', 'gridPower') || 0;
    let gridW;
    if (d.gridTo === true) gridW = Math.abs(gridRaw);
    else if (d.toGrid === true) gridW = -Math.abs(gridRaw);
    else if (d.gridTo === false && d.toGrid === false) gridW = 0;
    else gridW = gridRaw;

    return {
      pvW, loadW, batteryW, gridW,
      soc: pick(d, 'soc'),
      hasGrid: d.existsGrid !== false,
    };
  }

  function normalizeTotals(parts) {
    const p = parts || {};
    return {
      pvKwh: pick(p.pvInput, 'etoday', 'eToday') ?? pick(p.plant, 'etoday'),
      loadKwh: pick(p.load, 'dailyUsed', 'etodayUsed'),
      battChargeKwh: pick(p.battery, 'etodayChg', 'etodayCharge'),
      battDischargeKwh: pick(p.battery, 'etodayDischg', 'etodayDischarge'),
      gridImportKwh: pick(p.grid, 'etodayFrom', 'etodayBuy'),
      gridExportKwh: pick(p.grid, 'etodayTo', 'etodaySell'),
    };
  }

  // ---------------------------------------------------------------- weather

  function weatherUrl(lat, lon) {
    return 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat + '&longitude=' + lon
      + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,'
      + 'precipitation_sum,wind_speed_10m_max,sunshine_duration,shortwave_radiation_sum'
      + '&timezone=auto&forecast_days=4';
  }

  function geocodeUrl(query) {
    return 'https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name='
      + encodeURIComponent(query);
  }

  function normalizeWeather(j) {
    if (!j || !j.daily || !Array.isArray(j.daily.time)) return null;
    const d = j.daily;
    const at = (arr, i) => (Array.isArray(arr) ? num(arr[i]) : null);
    const days = d.time.map((date, i) => ({
      date,
      code: at(d.weather_code, i),
      max: at(d.temperature_2m_max, i),
      min: at(d.temperature_2m_min, i),
      rainProb: at(d.precipitation_probability_max, i),
      rainMm: at(d.precipitation_sum, i),
      windMax: at(d.wind_speed_10m_max, i),
      sunHours: at(d.sunshine_duration, i) === null ? null : at(d.sunshine_duration, i) / 3600,
      radiationMJ: at(d.shortwave_radiation_sum, i),
    }));
    const c = j.current || null;
    return {
      now: c ? {
        temp: num(c.temperature_2m),
        feels: num(c.apparent_temperature),
        code: num(c.weather_code),
        wind: num(c.wind_speed_10m),
        isDay: c.is_day !== 0,
      } : null,
      days,
    };
  }

  const WMO = [
    [[0], 'Clear', 'clear'],
    [[1], 'Mostly clear', 'partly'],
    [[2], 'Partly cloudy', 'partly'],
    [[3], 'Overcast', 'cloudy'],
    [[45, 48], 'Fog', 'fog'],
    [[51, 53, 55, 56, 57], 'Drizzle', 'drizzle'],
    [[61, 63, 66], 'Rain', 'rain'],
    [[65, 67], 'Heavy rain', 'rain'],
    [[80, 81], 'Showers', 'rain'],
    [[82], 'Heavy showers', 'rain'],
    [[71, 73, 75, 77, 85, 86], 'Snow', 'snow'],
    [[95], 'Thunderstorm', 'storm'],
    [[96, 99], 'Thunderstorm, hail', 'storm'],
  ];

  function describeWeather(code) {
    for (const [codes, label, icon] of WMO) if (codes.indexOf(code) !== -1) return { label, icon };
    return { label: '—', icon: 'cloudy' };
  }

  // Expected output from the panels: kWp × peak-sun-hours × performance ratio.
  // 1 kWh/m² = 3.6 MJ/m², and 1 kWh/m² of sun on 1 kWp is 1 kWh at nameplate.
  function estimateSolarKwh(kWp, radiationMJ) {
    if (!(kWp > 0) || radiationMJ === null || radiationMJ === undefined || !(radiationMJ >= 0)) return null;
    return kWp * (radiationMJ / 3.6) * PERFORMANCE_RATIO;
  }

  // ---------------------------------------------------------------- formatting

  function formatPower(w) {
    if (w === null || w === undefined || !Number.isFinite(w)) return '—';
    const a = Math.abs(w);
    if (a < 1000) return Math.round(a) + ' W';
    return (a / 1000).toFixed(a < 10000 ? 2 : 1).replace(/\.?0+$/, '') + ' kW';
  }

  function formatKwh(k) {
    if (k === null || k === undefined || !Number.isFinite(k)) return '—';
    return (k < 10 ? k.toFixed(1) : Math.round(k).toString()) + ' kWh';
  }

  // 'waiting' nothing yet · 'offline' Sunsynk unreachable · 'silent' Sunsynk fine but the
  // inverter has stopped reporting · 'stale' our last successful update is old · 'fresh'.
  function dataStatus(lastOkAt, lastFailed, nowMs, reportedAt) {
    if (!lastOkAt) return lastFailed ? 'offline' : 'waiting';
    if (lastFailed) return 'offline';
    if (reportedAt && nowMs - reportedAt > SYSTEM_SILENT_MS) return 'silent';
    return (nowMs - lastOkAt) > STALE_AFTER_MS ? 'stale' : 'fresh';
  }

  function isSilent(reportedAt, nowMs) {
    return !!reportedAt && nowMs - reportedAt > SYSTEM_SILENT_MS;
  }

  // Is a stored reading genuine? Only if it was fetched while the inverter was still
  // reporting — i.e. not long after its last upload. A reading with no capture time
  // (or one fetched long after the inverter fell silent) is a cloud zero, not a reading.
  function readingStillValid(flowAt, reportedAt) {
    if (!reportedAt) return true;            // nothing to judge it against
    return !!flowAt && flowAt <= reportedAt + SYSTEM_SILENT_MS;
  }

  const SolarCore = {
    API, SOURCE, POLL_MS, TOTALS_EVERY_N_POLLS, WEATHER_MS, STALE_AFTER_MS, SYSTEM_SILENT_MS, RETRY_DELAYS_MS,
    DEFAULT_LOCATION, PERFORMANCE_RATIO,
    md5, rsaPkcs1Encrypt, parseRsaPublicKey, cleanKey, b64ToBytes, bytesToB64, bytesToBigInt, bigIntToBytes, modPow,
    publicKeySign, tokenSign, SunsynkError, login, authedGet, createSession, decideAfterError, retryDelay,
    paths, localDate, normalizePlants, firstInverterSn, normalizeFlow, normalizeTotals,
    parseTime, inverterReportedAt, townFromAddress, normalizePlantDetail, redact,
    weatherUrl, geocodeUrl, normalizeWeather, describeWeather, estimateSolarKwh,
    formatPower, formatKwh, dataStatus, isSilent, readingStillValid,
  };

  root.SolarCore = SolarCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = SolarCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
