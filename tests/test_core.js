// Data rules, login flow and session behaviour — the real core.js, driven with a fake fetch.
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) passed++;
  else { failed++; console.log('FAIL  ' + name + (extra !== undefined ? '  — ' + JSON.stringify(extra) : '')); }
}

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
  const sandbox = { TextEncoder, atob, btoa, crypto: nodeCrypto.webcrypto, console, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'core.js' });
  return sandbox.SolarCore;
}
const C = loadCore();

// ---------------------------------------------------------------- flow
{
  const f = C.normalizeFlow({ pvPower: 3200, battPower: 1200, gridOrMeterPower: 0, loadOrEpsPower: 2000, soc: 64, toBat: true, batTo: false, gridTo: false, toGrid: false });
  check('charging: battery positive', f.batteryW === 1200, f);
  check('pv and load carried', f.pvW === 3200 && f.loadW === 2000);
  check('soc carried', f.soc === 64);
  check('grid idle with both flags false', f.gridW === 0);
}
{
  const f = C.normalizeFlow({ pvPower: 0, battPower: 800, gridOrMeterPower: 0, loadOrEpsPower: 800, soc: 51, toBat: false, batTo: true });
  check('discharging: battery negative', f.batteryW === -800, f);
}
{
  const f = C.normalizeFlow({ pvPower: 0, battPower: 0, gridOrMeterPower: 1500, loadOrEpsPower: 1500, gridTo: true, toGrid: false });
  check('importing: grid positive', f.gridW === 1500, f);
}
{
  const f = C.normalizeFlow({ pvPower: 6000, battPower: 0, gridOrMeterPower: 2100, loadOrEpsPower: 900, gridTo: false, toGrid: true });
  check('exporting: grid negative', f.gridW === -2100, f);
}
{
  // magnitude may arrive signed even with flags; the flags win
  const f = C.normalizeFlow({ battPower: -700, toBat: true, gridOrMeterPower: -300, gridTo: true });
  check('flags override a signed magnitude (battery)', f.batteryW === 700, f);
  check('flags override a signed magnitude (grid)', f.gridW === 300, f);
}
{
  const f = C.normalizeFlow({ battPower: 600, gridOrMeterPower: -250 });
  check('no flags: battery + means discharging', f.batteryW === -600, f);
  check('no flags: grid sign passes through', f.gridW === -250, f);
}
{
  const f = C.normalizeFlow({ pvPower: '1234.5', battPower: '0', loadOrEpsPower: '987', soc: '77.0' });
  check('numeric strings parsed', f.pvW === 1234.5 && f.loadW === 987 && f.soc === 77, f);
  check('missing grid flags default to connected', f.hasGrid === true);
}
{
  // A real reading (6 Oct 2026, morning): the battery charging from sun and grid. Sunsynk sends
  // a charging battery as a NEGATIVE battPower alongside toBat=true.
  const real = { pvPower: 1204, battPower: -2136, gridOrMeterPower: 1408, loadOrEpsPower: 307, soc: 30,
    pvTo: true, toLoad: true, toBat: true, batTo: false, gridTo: true, toGrid: false, existsGrid: true };
  const f = C.normalizeFlow(real);
  check('real reading: battery charging 2136 W', f.batteryW === 2136, f);
  check('real reading: grid importing 1408 W', f.gridW === 1408, f);
  check('real reading: power balances within inverter losses',
    Math.abs((f.pvW + f.gridW) - (f.batteryW + f.loadW)) / (f.pvW + f.gridW) < 0.1);
  const noFlags = C.normalizeFlow({ battPower: -2136, gridOrMeterPower: 1408 });
  check('same reading without flags reads the same way', noFlags.batteryW === 2136 && noFlags.gridW === 1408, noFlags);
}
check('off-grid flagged', C.normalizeFlow({ existsGrid: false }).hasGrid === false);
check('no data → null', C.normalizeFlow(null) === null);
check('missing soc → null', C.normalizeFlow({ pvPower: 1 }).soc === null);

// ---------------------------------------------------------------- totals, plants
{
  const t = C.normalizeTotals({
    pvInput: { etoday: '18.4' }, battery: { etodayChg: 6.3, etodayDischg: '4.1' },
    grid: { etodayFrom: 0.6, etodayTo: 2.4 }, load: { dailyUsed: 11.2 },
  });
  check('totals mapped', t.pvKwh === 18.4 && t.battChargeKwh === 6.3 && t.battDischargeKwh === 4.1
    && t.gridImportKwh === 0.6 && t.gridExportKwh === 2.4 && t.loadKwh === 11.2, t);
  const t2 = C.normalizeTotals({ plant: { etoday: 9.5 } });
  check('pv today falls back to the plant figure', t2.pvKwh === 9.5, t2);
  check('missing parts are null, not zero', t2.loadKwh === null && t2.gridImportKwh === null, t2);
  const t3 = C.normalizeTotals({ pvInput: { etoday: 0 }, plant: { etoday: 5 } });
  check('a real zero is kept, not replaced by the fallback', t3.pvKwh === 0, t3);
}
{
  const ps = C.normalizePlants({ infos: [{ id: 101, name: 'Buitekant', totalPower: 5.46, updateAt: 'x' }, { name: 'no id' }] });
  check('plants normalised', ps.length === 1 && ps[0].id === 101 && ps[0].kWp === 5.46 && ps[0].name === 'Buitekant', ps);
  check('plants from an empty answer', C.normalizePlants(null).length === 0);
  check('inverter serial', C.firstInverterSn({ infos: [{ sn: 2207123456 }] }) === '2207123456');
  check('no inverter → null', C.firstInverterSn({ infos: [] }) === null);
}

// ---------------------------------------------------------------- when the inverter last reported
check('ISO time with Z', C.parseTime('2026-10-06T00:31:27Z') === Date.UTC(2026, 9, 6, 0, 31, 27));
check('ISO time with offset', C.parseTime('2026-10-06T02:31:27+02:00') === Date.UTC(2026, 9, 6, 0, 31, 27));
check('ISO time with millis', C.parseTime('2026-02-26T14:17:37.752+00:00') === Date.UTC(2026, 1, 26, 14, 17, 37, 752));
check('a time without a zone is refused, not guessed', C.parseTime('2026-10-06 00:31:27') === null);
check('null / garbage time → null', C.parseTime(null) === null && C.parseTime('yesterday') === null && C.parseTime(1234) === null);
check('inverter reported-at', C.inverterReportedAt({ updateAt: '2026-10-06T00:31:27Z' }) === Date.UTC(2026, 9, 6, 0, 31, 27));
check('inverter reported-at missing', C.inverterReportedAt({}) === null && C.inverterReportedAt(null) === null);
{
  const now = Date.UTC(2026, 9, 6, 6, 18, 51);           // 08:18 SAST, the moment the real system was found silent
  const at = Date.UTC(2026, 9, 6, 0, 31, 27);            // its last upload, 02:31 SAST
  check('silent after ~6 hours', C.isSilent(at, now));
  check('not silent after 19 minutes', !C.isSilent(now - 19 * 60_000, now));
  check('silent after 21 minutes', C.isSilent(now - 21 * 60_000, now));
  check('unknown report time is not called silent', !C.isSilent(null, now));
  check('status: Sunsynk answers but the inverter is quiet → silent', C.dataStatus(now - 60_000, false, now, at) === 'silent');
  check('status: reporting inverter → fresh', C.dataStatus(now - 60_000, false, now, now - 4 * 60_000) === 'fresh');
  check('status: a failed poll outranks silence', C.dataStatus(now - 60_000, true, now, at) === 'offline');

  // Which stored readings may be shown while the inverter is silent
  check('zeros fetched 6 hours after it fell silent are not a reading', !C.readingStillValid(now, at));
  check('a reading fetched while it was still reporting is kept', C.readingStillValid(at + 4 * 60_000, at));
  check('a reading from before its last upload is kept', C.readingStillValid(at - 60_000, at));
  check('a stored reading with no capture time is not trusted', !C.readingStillValid(null, at));
  check('with no report time there is nothing to judge against', C.readingStillValid(null, null) && C.readingStillValid(now, null));
}

// ---------------------------------------------------------------- plant detail (shape of a real answer, values invented)
{
  const detail = {
    id: 1, name: 'Test house', totalPower: 6.05, lat: -33.586, lon: 22.203,
    address: '12 Example Street, Oudtshoorn, 6620, South Africa', status: 0,
    email: 'someone@example.com', phone: '000', installer: { name: 'x' }, master: { id: 2 },
    timezone: { code: 'Africa/Harare' },
    realtime: { pac: 0, etoday: 3.4, totalPower: 6.05, updateAt: '2026-10-06T00:26:57Z' },
  };
  const info = C.normalizePlantDetail(detail);
  check('plant size (kWp)', info.kWp === 6.05, info.kWp);
  check('plant coordinates', info.lat === -33.586 && info.lon === 22.203);
  check('plant town from the address', info.town === 'Oudtshoorn', info.town);
  check('plant reported-at from realtime', info.reportedAt === Date.UTC(2026, 9, 6, 0, 26, 57));
  check('plant realtime kept for the solar-today fallback', info.realtime.etoday === 3.4);
  check('kWp falls back to realtime', C.normalizePlantDetail({ realtime: { totalPower: 4.2 } }).kWp === 4.2);
  check('0,0 is "no location", not the Gulf of Guinea', C.normalizePlantDetail({ lat: 0, lon: 0 }).lat === null);
  check('no detail → null', C.normalizePlantDetail(null) === null);
  check('town from a Buitekant address', C.townFromAddress('49 Buitekant Street, Oudtshoorn, 6625') === 'Oudtshoorn');
  check('town from nothing', C.townFromAddress('') === null && C.townFromAddress(null) === null);

  const r = C.redact({ raw: detail, list: [{ email: 'a@b.c', sn: '123' }], email: null });
  check('diagnostics hide contact details', r.raw.email === '(hidden)' && r.raw.phone === '(hidden)' && r.raw.installer === '(hidden)' && r.raw.master === '(hidden)');
  check('diagnostics hide them inside lists too', r.list[0].email === '(hidden)' && r.list[0].sn === '123');
  check('diagnostics keep the useful fields', r.raw.totalPower === 6.05 && r.raw.realtime.updateAt === '2026-10-06T00:26:57Z');
  check('an empty contact field stays visibly empty', r.email === null);
}
check('plant detail path', C.paths.plantDetail(1001) === '/api/v1/plant/1001?lan=en&id=1001');
check('inverter path', C.paths.inverter('1234567890') === '/api/v1/inverter/1234567890');

// ---------------------------------------------------------------- formatting
const fp = [[0, '0 W'], [19.6, '20 W'], [999, '999 W'], [1000, '1 kW'], [1200, '1.2 kW'], [1250, '1.25 kW'],
  [9999, '10 kW'], [12345, '12.3 kW'], [-800, '800 W'], [-3500, '3.5 kW'], [null, '—'], [NaN, '—']];
for (const [w, want] of fp) check('formatPower(' + w + ')', C.formatPower(w) === want, C.formatPower(w));
const fk = [[0, '0.0 kWh'], [9.94, '9.9 kWh'], [12.6, '13 kWh'], [null, '—']];
for (const [k, want] of fk) check('formatKwh(' + k + ')', C.formatKwh(k) === want, C.formatKwh(k));

// ---------------------------------------------------------------- weather
const groups = { 0: 'clear', 1: 'partly', 2: 'partly', 3: 'cloudy', 45: 'fog', 51: 'drizzle', 61: 'rain', 65: 'rain',
  80: 'rain', 71: 'snow', 95: 'storm', 99: 'storm' };
for (const [code, icon] of Object.entries(groups)) check('weather code ' + code, C.describeWeather(Number(code)).icon === icon);
check('unknown weather code', C.describeWeather(12345).label === '—');

const sample = {   // a real Open-Meteo answer for Oudtshoorn, trimmed
  current: { temperature_2m: 21.4, apparent_temperature: 20.1, weather_code: 3, wind_speed_10m: 11.2, is_day: 1 },
  daily: {
    time: ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
    weather_code: [51, 2, 1, 3], temperature_2m_max: [25.1, 24.5, 30.7, 28.0], temperature_2m_min: [12.2, 7.3, 10.7, 9.7],
    precipitation_probability_max: [100, 2, 0, 2], precipitation_sum: [0.3, 0, 0, 0], wind_speed_10m_max: [22.4, 25.3, 23.5, 20.5],
    sunshine_duration: [10788.24, 44984.78, 45010.33, 45227.76], shortwave_radiation_sum: [8.46, 26.05, 25.66, 25.56],
  },
};
{
  const w = C.normalizeWeather(sample);
  check('four days', w.days.length === 4);
  check('day fields', w.days[1].max === 24.5 && w.days[1].min === 7.3 && w.days[1].rainProb === 2 && w.days[1].code === 2, w.days[1]);
  check('sunshine seconds → hours', Math.abs(w.days[1].sunHours - 12.4958) < 0.001, w.days[1].sunHours);
  check('current conditions', w.now.temp === 21.4 && w.now.code === 3 && w.now.isDay === true, w.now);
  check('night flagged', C.normalizeWeather({ ...sample, current: { ...sample.current, is_day: 0 } }).now.isDay === false);
  check('no current block → now is null', C.normalizeWeather({ daily: sample.daily }).now === null);
  check('garbage → null', C.normalizeWeather({}) === null);
}
{
  const u = C.weatherUrl(-33.5947, 22.1927);
  check('weather url location', u.includes('latitude=-33.5947') && u.includes('longitude=22.1927'));
  check('weather url asks for 4 days and radiation', u.includes('forecast_days=4') && u.includes('shortwave_radiation_sum'));
  check('default location is Buitekant, Oudtshoorn', C.DEFAULT_LOCATION.lat === -33.5947 && C.DEFAULT_LOCATION.lon === 22.1927);
}
check('solar estimate', Math.abs(C.estimateSolarKwh(5.5, 26.1) - 5.5 * (26.1 / 3.6) * 0.75) < 1e-9);
check('solar estimate is ~30 kWh for 5.5 kWp on a clear spring day', Math.round(C.estimateSolarKwh(5.5, 26.1)) === 30);
check('no estimate without system size', C.estimateSolarKwh(null, 26) === null && C.estimateSolarKwh(0, 26) === null);
check('no estimate without radiation', C.estimateSolarKwh(5, null) === null);
check('zero radiation → zero', C.estimateSolarKwh(5, 0) === 0);

// ---------------------------------------------------------------- status and retry
const T = 1_000_000_000_000;
check('never updated → waiting', C.dataStatus(null, false, T) === 'waiting');
check('never updated, failing → offline', C.dataStatus(null, true, T) === 'offline');
check('just updated → fresh', C.dataStatus(T - 60_000, false, T) === 'fresh');
check('11 minutes old → stale', C.dataStatus(T - 11 * 60_000, false, T) === 'stale');
check('last poll failed → offline even if recent', C.dataStatus(T - 60_000, true, T) === 'offline');
check('retry 1 → 1 min', C.retryDelay(1) === 60_000);
check('retry 2 → 2 min', C.retryDelay(2) === 120_000);
check('retry 3 → 5 min', C.retryDelay(3) === 300_000);
check('retry 20 → still 5 min', C.retryDelay(20) === 300_000);
check('retry 0 → 1 min', C.retryDelay(0) === 60_000);
check('refused login → setup, no timer', (() => { const d = C.decideAfterError(new C.SunsynkError('x', 'auth'), 1); return d.action === 'setup' && d.delayMs === null; })());
for (const kind of ['network', 'server', 'expired']) {
  const d = C.decideAfterError(new C.SunsynkError('x', kind), 2);
  check(kind + ' error → retry with backoff', d.action === 'retry' && d.delayMs === 120_000, d);
}
check('polling stays gentle', C.POLL_MS >= 60_000);

// ---------------------------------------------------------------- paths
check('flow path', C.paths.flow(123, '2026-10-06') === '/api/v1/plant/energy/123/flow?date=2026-10-06');
check('battery path', C.paths.battery('SN 1') === '/api/v1/inverter/battery/SN%201/realtime?sn=SN%201&lan=en');
check('local date format', /^\d{4}-\d{2}-\d{2}$/.test(C.localDate(new Date(2026, 0, 5))) && C.localDate(new Date(2026, 0, 5)) === '2026-01-05');

// ---------------------------------------------------------------- login against a fake Sunsynk
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const JWK = privateKey.export({ format: 'jwk' });
function rsaDecrypt(b64) {
  const big = (s) => BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'));
  const n = big(JWK.n), d = big(JWK.d), k = Buffer.from(JWK.n, 'base64url').length;
  const m = C.modPow(BigInt('0x' + Buffer.from(b64, 'base64').toString('hex')), d, n);
  const em = Buffer.from(m.toString(16).padStart(k * 2, '0'), 'hex');
  return em.slice(em.indexOf(0, 2) + 1).toString('utf8');
}
const md5 = (s) => nodeCrypto.createHash('md5').update(s).digest('hex');

function fakeSunsynk(opts) {
  const o = Object.assign({ password: 'right', tokenLife: 604799, keyCode: 0 }, opts);
  const log = [];
  let issued = 0;
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  async function fetchFn(url, init) {
    const u = new URL(url);
    log.push({ path: u.pathname, url, init });
    if (o.offline) throw new TypeError('Failed to fetch');
    if (u.pathname === '/anonymous/publicKey') {
      if (o.keyStatus) return reply(o.keyStatus, {});
      return reply(200, { code: o.keyCode, msg: o.keyCode ? 'nope' : 'Success', data: o.keyCode ? null : SPKI });
    }
    if (u.pathname === '/oauth/token/new') {
      const b = JSON.parse(init.body);
      const pw = rsaDecrypt(b.password);
      const wantSign = md5('nonce=' + b.nonce + '&source=sunsynk' + SPKI.slice(0, 10));
      if (b.sign !== wantSign) return reply(200, { code: 115, msg: 'Invalid login interface request!' });
      if (pw !== o.password) return reply(200, { code: 102, msg: 'Account or password error' });
      issued++;
      return reply(200, { code: 0, msg: 'Success', data: { access_token: 'tok' + issued, expires_in: o.tokenLife } });
    }
    if (u.pathname.startsWith('/api/')) {
      const auth = (init.headers || {}).Authorization;
      if (o.rejectToken && o.rejectToken(auth)) return reply(401, {});
      return reply(200, { code: 0, msg: 'Success', data: { path: u.pathname, auth } });
    }
    return reply(404, {});
  }
  return { fetchFn, log, issued: () => issued };
}

(async () => {
  // successful login: exact requests
  {
    const s = fakeSunsynk();
    let clock = 1759730000000;
    const tok = await C.login(s.fetchFn, 'owner@example.com', 'right', () => clock);
    const keyReq = new URL(s.log[0].url);
    check('asks for the public key first', s.log[0].path === '/anonymous/publicKey');
    check('key request source', keyReq.searchParams.get('source') === 'sunsynk');
    check('key request sign', keyReq.searchParams.get('sign') === md5('nonce=' + keyReq.searchParams.get('nonce') + '&source=sunsynkPOWER_VIEW'));
    const body = JSON.parse(s.log[1].init.body);
    check('token request goes to /oauth/token/new by POST', s.log[1].path === '/oauth/token/new' && s.log[1].init.method === 'POST');
    check('token body fields', body.client_id === 'csp-web' && body.grant_type === 'password' && body.source === 'sunsynk' && body.username === 'owner@example.com', body);
    check('password travels encrypted, never in clear', body.password !== 'right' && rsaDecrypt(body.password) === 'right');
    check('access token returned', tok.accessToken === 'tok1');
    check('expiry is the token life less a 5-minute margin', tok.expiresAt === clock + 604799 * 1000 - 5 * 60 * 1000, tok.expiresAt - clock);
  }
  // wrong password
  {
    const s = fakeSunsynk();
    let err;
    try { await C.login(s.fetchFn, 'owner@example.com', 'wrong'); } catch (e) { err = e; }
    check('wrong password → auth error', err && err.kind === 'auth', err && err.kind);
    check('wrong password carries Sunsynk\'s code', err && err.detail && err.detail.code === 102);
    check('wrong password message is Sunsynk\'s', err && /password error/.test(err.message));
  }
  // network problems
  {
    let err;
    try { await C.login(fakeSunsynk({ offline: true }).fetchFn, 'a@b.c', 'right'); } catch (e) { err = e; }
    check('offline → network error', err && err.kind === 'network', err && err.kind);
    err = null;
    try { await C.login(fakeSunsynk({ keyStatus: 502 }).fetchFn, 'a@b.c', 'right'); } catch (e) { err = e; }
    check('HTTP 502 → network error', err && err.kind === 'network', err && err.kind);
    err = null;
    try { await C.login(fakeSunsynk({ keyCode: 500 }).fetchFn, 'a@b.c', 'right'); } catch (e) { err = e; }
    check('no public key → server error (retryable, not a password problem)', err && err.kind === 'server', err && err.kind);
  }
  // blank credentials never reach the network
  {
    const s = fakeSunsynk();
    let err;
    try { await C.login(s.fetchFn, '', 'x'); } catch (e) { err = e; }
    check('blank email refused locally', err && err.kind === 'auth' && s.log.length === 0);
  }

  // ---------------------------------------------------------------- session
  {
    const s = fakeSunsynk();
    let clock = 1759730000000, saved = null;
    const sess = C.createSession({ fetchFn: s.fetchFn, nowFn: () => clock, getCreds: () => ({ username: 'o@e.com', password: 'right' }), saveToken: (t) => { saved = t; } });
    const a = await sess.get('/api/v1/plants');
    const b = await sess.get('/api/v1/plants');
    check('session logs in once and reuses the token', s.issued() === 1 && a.auth === 'Bearer tok1' && b.auth === 'Bearer tok1');
    check('session saves the token', saved && saved.accessToken === 'tok1');
    clock += 604799 * 1000;   // past expiry
    const c = await sess.get('/api/v1/plants');
    check('expired token → logs in again', s.issued() === 2 && c.auth === 'Bearer tok2');
  }
  {
    // a stored token that Sunsynk has already revoked: one fresh login, then success
    const s = fakeSunsynk({ rejectToken: (auth) => auth === 'Bearer stale' });
    const sess = C.createSession({ fetchFn: s.fetchFn, loadToken: () => ({ accessToken: 'stale', expiresAt: Date.now() + 1e9 }), getCreds: () => ({ username: 'o@e.com', password: 'right' }) });
    const r = await sess.get('/api/v1/plants');
    check('revoked token → one re-login, then the data', r.auth === 'Bearer tok1' && s.issued() === 1);
  }
  {
    // a 401 that persists even after a fresh login must not loop
    const s = fakeSunsynk({ rejectToken: () => true });
    const sess = C.createSession({ fetchFn: s.fetchFn, getCreds: () => ({ username: 'o@e.com', password: 'right' }) });
    let err;
    try { await sess.get('/api/v1/plants'); } catch (e) { err = e; }
    check('persistent 401 → gives up after one retry', err && err.kind === 'expired' && s.issued() === 2, { kind: err && err.kind, issued: s.issued() });
  }
  {
    // password changed in the Sunsynk app since setup: the next login fails → setup screen, no timer
    const s = fakeSunsynk({ password: 'changed' });
    const sess = C.createSession({ fetchFn: s.fetchFn, getCreds: () => ({ username: 'o@e.com', password: 'old' }) });
    let err;
    try { await sess.get('/api/v1/plants'); } catch (e) { err = e; }
    const d = C.decideAfterError(err, 1);
    check('changed password → setup screen, not a retry loop', d.action === 'setup');
    const attempts = s.log.filter((x) => x.path === '/oauth/token/new').length;
    check('only one login attempt made', attempts === 1, attempts);
  }
  {
    const sess = C.createSession({ fetchFn: fakeSunsynk().fetchFn, getCreds: () => null });
    let err;
    try { await sess.get('/api/v1/plants'); } catch (e) { err = e; }
    check('not signed in → auth error', err && err.kind === 'auth');
  }
  {
    // a data request Sunsynk refuses (code != 0) is retryable, not a password problem
    const reply = { ok: true, status: 200, json: async () => ({ code: 500, msg: 'busy' }) };
    let err;
    try { await C.authedGet(async () => reply, 'tok', '/api/v1/plants'); } catch (e) { err = e; }
    check('refused data request → server error', err && err.kind === 'server' && /busy/.test(err.message));
  }

  // ---------------------------------------------------------------- shipping checks
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const appVersion = (appSrc.match(/APP_VERSION = '([^']+)'/) || [])[1];
  const fileVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
  check('version.json matches APP_VERSION (otherwise tablets reload for nothing)', appVersion && appVersion === fileVersion, { appVersion, fileVersion });

  const setupBranch = appSrc.slice(appSrc.indexOf("if (next.action === 'setup')"), appSrc.indexOf('} else {', appSrc.indexOf("if (next.action === 'setup')")));
  check('the refused-login branch schedules no retry', setupBranch.length > 0 && !/schedulePoll/.test(setupBranch), setupBranch.slice(0, 80));

  // A silent inverter's zeros must never overwrite the last real reading.
  const pollBody = appSrc.slice(appSrc.indexOf('async function pollSunsynk'), appSrc.indexOf('// ------', appSrc.indexOf('async function pollSunsynk')));
  const flowAssignments = pollBody.match(/state\.flow\s*=\s*flow/g) || [];
  check('the live reading is only stored behind the silence check, with its capture time',
    flowAssignments.length === 1
    && /if \(!Core\.isSilent\(state\.reportedAt, Date\.now\(\)\)\) \{ state\.flow = flow; state\.flowAt = Date\.now\(\); \}/.test(pollBody));
  const renderBody = appSrc.slice(appSrc.indexOf('function renderPower()'), appSrc.indexOf('function renderEmptyPower'));
  check('the screen draws the checked reading, not the raw stored one', /const f = displayFlow\(\);/.test(renderBody) && !/const f = state\.flow/.test(renderBody));

  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  for (const f of shell) check('service worker file exists: ' + f, fs.existsSync(path.join(ROOT, f)));
  check('service worker leaves other origins alone', /url\.origin !== self\.location\.origin\) return/.test(sw));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const i of manifest.icons) check('manifest icon exists: ' + i.src, fs.existsSync(path.join(ROOT, i.src)));
  check('manifest has a 512 maskable icon', manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  check('manifest opens landscape full-screen', manifest.orientation === 'landscape' && manifest.display === 'fullscreen');

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('no third-party scripts or styles', !/<script[^>]+src="https?:/i.test(html) && !/<link[^>]+href="https?:/i.test(html));
  const remote = (appSrc + fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8')).match(/https:\/\/[a-z0-9.-]+/gi) || [];
  const hosts = [...new Set(remote.map((u) => new URL(u).host))].sort();
  check('the app talks only to Sunsynk and Open-Meteo', JSON.stringify(hosts) === JSON.stringify(['api.open-meteo.com', 'api.sunsynk.net', 'geocoding-api.open-meteo.com']), hosts);

  console.log(`test_core: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
