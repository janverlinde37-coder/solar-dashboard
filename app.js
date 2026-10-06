/* app.js — the screen. All data rules live in core.js. */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const Core = window.SolarCore;
  const params = new URLSearchParams(location.search);
  const DEMO = params.has('demo');
  const IDLE_W = 20;   // below this a link is drawn as idle

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------ storage
  const K = {
    creds: 'ssd.v1.creds',
    token: 'ssd.v1.token',
    plant: 'ssd.v1.plant',
    location: 'ssd.v1.location',
    last: 'ssd.v1.last',
    weather: 'ssd.v1.weather',
  };
  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) {
      try {
        if (v === null || v === undefined) localStorage.removeItem(k);
        else localStorage.setItem(k, JSON.stringify(v));
      } catch (e) { /* private mode or full: the dashboard still runs, it just forgets on reload */ }
    },
  };

  const state = {
    creds: DEMO ? null : store.get(K.creds),
    token: DEMO ? null : store.get(K.token),
    plant: DEMO ? null : store.get(K.plant),
    location: store.get(K.location) || Core.DEFAULT_LOCATION,
    flow: null,          // the last GOOD live reading — never the zeros a silent inverter returns
    flowAt: null,        // when that reading was fetched
    totals: null,
    reportedAt: null,    // when the inverter itself last uploaded to Sunsynk
    weather: null,
  };

  // Show whatever we last knew immediately; a wall display should never open blank.
  const last = DEMO ? null : store.get(K.last);
  let lastOkAt = null;
  if (last && state.plant && last.plantId === state.plant.id) {
    state.flow = last.flow; state.flowAt = last.flowAt || null; state.totals = last.totals;
    lastOkAt = last.okAt; state.reportedAt = last.reportedAt || null;
  }
  const cachedWx = store.get(K.weather);
  if (cachedWx && cachedWx.lat === state.location.lat && cachedWx.lon === state.location.lon) state.weather = cachedWx.data;

  const session = Core.createSession({
    fetchFn: (u, o) => fetch(u, o),
    getCreds: () => state.creds,
    loadToken: () => state.token,
    saveToken: (t) => { state.token = t; store.set(K.token, t); },
  });

  let pollCount = 0, failCount = 0, lastFailed = false, nextRetryAt = null, polling = false, lastErr = null;
  const timers = { poll: null, wx: null };

  // ------------------------------------------------------------ icons
  const NODE_ICON = {
    solar: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3"/><path d="M6 10v4M9.5 10v4M13 10v4"/>',
    grid: '<path d="M8 21 12 3l4 18M6.5 8h11M5 13h14M9 21l7-8M15 21l-7-8"/>',
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5.5h4V20"/>',
  };

  const CLOUD = 'M18 48a10 10 0 0 1 0-20 14 14 0 0 1 26.5-4.5A11.5 11.5 0 0 1 47 48z';
  function sun(cx, cy, r) {
    let rays = '';
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4);
      const x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
      rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    return `<g stroke="var(--wx-sun)" stroke-width="3.5" stroke-linecap="round">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--wx-sun)"/>`;
  }
  const MOON = '<path d="M38 10a20 20 0 1 0 16 30A17 17 0 0 1 38 10z" fill="var(--wx-cloud)"/>';
  function cloud(tx, ty, s, fill) {
    return `<path d="${CLOUD}" fill="${fill || 'var(--wx-cloud)'}" transform="translate(${tx} ${ty}) scale(${s})"/>`;
  }
  function wxIcon(kind, isDay) {
    const day = isDay !== false;
    let body;
    switch (kind) {
      case 'clear': body = day ? sun(32, 32, 12) : MOON; break;
      case 'partly': body = (day ? sun(24, 24, 9) : '<g transform="translate(-8 -6) scale(0.8)">' + MOON + '</g>') + cloud(10, 8, 0.85); break;
      case 'cloudy': body = cloud(-6, 2, 1.12, '#8f8e88') + cloud(4, 8, 0.95); break;
      case 'fog': body = cloud(0, -6, 1) + '<g stroke="var(--wx-cloud)" stroke-width="3.5" stroke-linecap="round"><line x1="14" y1="50" x2="50" y2="50"/><line x1="20" y1="57" x2="44" y2="57"/></g>'; break;
      case 'drizzle': body = cloud(0, -8, 1) + '<g stroke="var(--wx-rain)" stroke-width="3.5" stroke-linecap="round"><line x1="24" y1="48" x2="22" y2="53"/><line x1="36" y1="48" x2="34" y2="53"/></g>'; break;
      case 'rain': body = cloud(0, -8, 1) + '<g stroke="var(--wx-rain)" stroke-width="3.5" stroke-linecap="round"><line x1="21" y1="47" x2="17" y2="57"/><line x1="32" y1="47" x2="28" y2="57"/><line x1="43" y1="47" x2="39" y2="57"/></g>'; break;
      case 'snow': body = cloud(0, -8, 1) + '<g fill="var(--wx-snow)"><circle cx="20" cy="51" r="2.6"/><circle cx="32" cy="55" r="2.6"/><circle cx="44" cy="51" r="2.6"/></g>'; break;
      case 'storm': body = cloud(0, -8, 1) + '<path d="M34 42 25 54h7l-4 9 12-14h-7l4-7z" fill="var(--wx-sun)"/>'; break;
      default: body = cloud(0, 2, 1);
    }
    return `<svg class="wx" viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
  }
  const DROP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" fill="var(--wx-rain)"/></svg>';
  const WIND = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"><path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/></svg>';
  const SUNSM = '<svg viewBox="0 0 64 64" aria-hidden="true">' + sun(32, 32, 11) + '</svg>';

  // ------------------------------------------------------------ flow diagram
  // Each link is drawn from A to B; `forward` means power is moving A → B.
  const NODES = {
    solar: { x: 200, y: 46, color: 'var(--solar)', label: 'SOLAR' },
    battery: { x: 62, y: 158, color: 'var(--battery)', label: 'BATTERY' },
    grid: { x: 338, y: 158, color: 'var(--grid)', label: 'GRID' },
    home: { x: 200, y: 270, color: 'var(--home)', label: 'HOME' },
  };
  const HUB = { x: 200, y: 158 };
  const LINKS = {
    solar: { a: [200, 79], b: [200, 147] },
    battery: { a: [95, 158], b: [189, 158] },
    grid: { a: [305, 158], b: [211, 158] },
    home: { a: [200, 169], b: [200, 237] },
  };
  const flowRefs = {};

  function buildFlow() {
    const svg = $('#flow');
    let html = '';
    for (const [k, L] of Object.entries(LINKS)) {
      html += `<line class="track" x1="${L.a[0]}" y1="${L.a[1]}" x2="${L.b[0]}" y2="${L.b[1]}"/>`;
      html += `<path class="stream idle" id="st-${k}" stroke="${NODES[k].color}" d="M${L.a[0]} ${L.a[1]}L${L.b[0]} ${L.b[1]}"/>`;
      html += `<path class="arrow idle" id="ar-${k}" fill="${NODES[k].color}" d="M-6 -5 L4 0 L-6 5 Z"/>`;
    }
    html += `<circle class="hub" cx="${HUB.x}" cy="${HUB.y}" r="11"/>`;
    for (const [k, n] of Object.entries(NODES)) {
      html += `<circle class="node-bg off" id="nb-${k}" cx="${n.x}" cy="${n.y}" r="32" stroke="${n.color}"/>`;
      html += `<g transform="translate(${n.x - 15} ${n.y - 15}) scale(1.25)" fill="none" stroke="${n.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${NODE_ICON[k]}</g>`;
    }
    // Text: solar and home sit to the right of their node; battery and grid below theirs.
    html += textBlock('solar', 244, 36, 'start');
    html += textBlock('home', 244, 260, 'start');
    html += textBlock('battery', 62, 208, 'middle');
    html += textBlock('grid', 338, 208, 'middle');
    svg.innerHTML = html;
    for (const k of Object.keys(NODES)) {
      flowRefs[k] = {
        stream: document.getElementById('st-' + k),
        arrow: document.getElementById('ar-' + k),
        bg: document.getElementById('nb-' + k),
        val: document.getElementById('v-' + k),
        sub: document.getElementById('s-' + k),
      };
    }
  }

  function textBlock(k, x, y, anchor) {
    return `<text class="lbl" x="${x}" y="${y}" text-anchor="${anchor}">${NODES[k].label}</text>`
      + `<text class="val" id="v-${k}" x="${x}" y="${y + 24}" text-anchor="${anchor}">—</text>`
      + `<text class="lbl" id="s-${k}" x="${x}" y="${y + 42}" text-anchor="${anchor}"></text>`;
  }

  function setLink(k, watts, forward) {
    const r = flowRefs[k];
    const L = LINKS[k];
    const active = Math.abs(watts || 0) >= IDLE_W;
    const [from, to] = forward ? [L.a, L.b] : [L.b, L.a];
    r.stream.setAttribute('d', `M${from[0]} ${from[1]}L${to[0]} ${to[1]}`);
    r.stream.setAttribute('class', 'stream ' + (active ? 'run' : 'idle'));
    const mx = (from[0] + to[0]) / 2, my = (from[1] + to[1]) / 2;
    const ang = Math.atan2(to[1] - from[1], to[0] - from[0]) * 180 / Math.PI;
    r.arrow.setAttribute('transform', `translate(${mx} ${my}) rotate(${ang})`);
    r.arrow.setAttribute('class', 'arrow ' + (active ? '' : 'idle'));
    r.bg.setAttribute('class', 'node-bg' + (active ? '' : ' off'));
  }

  // ------------------------------------------------------------ rendering: power
  // The reading worth showing: a silent inverter's zeros, or anything fetched after it
  // fell silent, is not a reading at all.
  function displayFlow() {
    if (DEMO || !state.flow) return state.flow;
    return Core.readingStillValid(state.flowAt, state.reportedAt) ? state.flow : null;
  }

  function renderPower() {
    const f = displayFlow();
    const st = dataStatusNow();
    const old = st === 'stale' || st === 'offline' || st === 'silent';
    $('#flow').classList.toggle('is-old', old && !!f);
    renderPowerNote(st);
    if (!f) { renderEmptyPower(); renderTotals(old); return; }

    setLink('solar', f.pvW, true);
    setLink('home', f.loadW, true);
    setLink('battery', f.batteryW, f.batteryW < 0);   // discharging flows towards the house
    setLink('grid', f.gridW, f.gridW > 0);            // importing flows towards the house

    flowRefs.solar.val.textContent = Core.formatPower(f.pvW);
    flowRefs.solar.sub.textContent = '';
    flowRefs.home.val.textContent = Core.formatPower(f.loadW);
    flowRefs.home.sub.textContent = '';

    const bAbs = Math.abs(f.batteryW);
    flowRefs.battery.val.textContent = Core.formatPower(bAbs);
    flowRefs.battery.sub.textContent = bAbs < IDLE_W ? 'IDLE' : (f.batteryW > 0 ? 'CHARGING' : 'DISCHARGING');

    const gAbs = Math.abs(f.gridW);
    if (!f.hasGrid) {
      flowRefs.grid.val.textContent = '—';
      flowRefs.grid.sub.textContent = 'NOT CONNECTED';
    } else {
      flowRefs.grid.val.textContent = Core.formatPower(gAbs);
      flowRefs.grid.sub.textContent = gAbs < IDLE_W ? 'IDLE' : (f.gridW > 0 ? 'IMPORTING' : 'EXPORTING');
    }

    const soc = f.soc;
    $('#soc').innerHTML = (soc === null || soc === undefined ? '--' : Math.round(soc)) + '<small>%</small>';
    $('#meterFill').style.width = (soc == null ? 0 : Math.max(0, Math.min(100, soc))) + '%';
    const low = soc !== null && soc !== undefined && soc < 20;
    $('#meter').classList.toggle('low', low);
    const stateWord = bAbs < IDLE_W ? 'Idle' : (f.batteryW > 0 ? 'Charging' : 'Discharging');
    $('#battState').innerHTML = 'Battery · ' + stateWord + (low ? '<span class="tag low">Low</span>' : '');
    $('#battPower').innerHTML = bAbs < IDLE_W ? '' : '<b>' + esc(Core.formatPower(bAbs)) + '</b>';
    document.querySelector('.battery-row').classList.toggle('is-old', old);

    renderTotals(old);
  }

  // No real reading yet: dashes, never zeros.
  function renderEmptyPower() {
    for (const k of Object.keys(NODES)) {
      setLink(k, 0, true);
      flowRefs[k].val.textContent = '—';
      flowRefs[k].sub.textContent = '';
    }
    $('#soc').innerHTML = '--<small>%</small>';
    $('#meterFill').style.width = '0%';
    $('#meter').classList.remove('low');
    $('#battState').textContent = 'Battery';
    $('#battPower').textContent = '';
  }

  // Says in plain words why the numbers are old, and what to check.
  function renderPowerNote(st) {
    const el = $('#powerNote');
    let text = '';
    if (st === 'silent') {
      text = 'The inverter hasn’t sent anything to Sunsynk since ' + whenText(state.reportedAt)
        + '. Check that the inverter’s Wi-Fi dongle has power and the router is on. '
        + (displayFlow() ? 'Showing its last readings.' : 'There are no readings to show until it reports again.');
    } else if (st === 'offline' && lastOkAt) {
      text = 'Can’t reach Sunsynk, so these are the readings from ' + whenText(lastOkAt) + '. Check the tablet’s internet connection.';
    }
    el.textContent = text;
    el.hidden = !text;
  }

  function whenText(ms) {
    if (!ms) return 'a while ago';
    const d = new Date(ms);
    const today = Core.localDate();
    const yesterday = Core.localDate(new Date(Date.now() - 86400000));
    const day = Core.localDate(d);
    if (day === today) return hhmm(ms);
    if (day === yesterday) return 'yesterday ' + hhmm(ms);
    return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + hhmm(ms);
  }

  function renderTotals(old) {
    const t = state.totals || {};
    const items = [
      ['Solar', t.pvKwh, 'var(--solar)'],
      ['Battery in', t.battChargeKwh, 'var(--battery)'],
      ['Grid in', t.gridImportKwh, 'var(--grid)'],
      ['Used', t.loadKwh, 'var(--home)'],
      ['Battery out', t.battDischargeKwh, 'var(--battery)'],
      ['Grid out', t.gridExportKwh, 'var(--grid)'],
    ];
    const el = $('#totals');
    el.innerHTML = items.map(([k, v, c]) =>
      `<div class="t"><span class="sw" style="background:${c}"></span><span class="k">${k}</span><span class="v">${esc(Core.formatKwh(v))}</span></div>`).join('');
    el.classList.toggle('is-old', !!old);
  }

  // ------------------------------------------------------------ rendering: status + clock
  function dataStatusNow() {
    if (DEMO) return 'fresh';
    return Core.dataStatus(lastOkAt, lastFailed, Date.now(), state.reportedAt);
  }
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  function renderStatus() {
    const s = dataStatusNow();
    const dot = $('#statusDot');
    dot.className = 'dot ' + (s === 'waiting' ? '' : s === 'silent' ? 'offline' : s);
    let text;
    if (DEMO) text = 'Demo data';
    else if (!state.creds) text = 'Not signed in';
    else if (s === 'waiting') text = 'Connecting to Sunsynk…';
    else if (s === 'fresh') text = 'Updated ' + hhmm(lastOkAt);
    else if (s === 'silent') text = 'Inverter not reporting since ' + whenText(state.reportedAt);
    else if (s === 'stale') text = 'Updated ' + hhmm(lastOkAt) + ' · data is old';
    else text = (lastOkAt ? 'Offline since ' + hhmm(lastOkAt) : 'Can’t reach Sunsynk') + (nextRetryAt ? ' · retry ' + hhmm(nextRetryAt) : '');
    $('#statusText').textContent = text;
    $('#statusPill').title = lastErr ? String(lastErr.message || lastErr) : '';
    $('#place').textContent = DEMO ? 'Demo system' : (state.plant ? state.plant.name : '');
  }

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let lastMinute = '', lastDay = '';
  function tickClock() {
    const d = new Date();
    const t = hhmm(d.getTime());
    if (t !== lastMinute) {
      lastMinute = t;
      $('#time').textContent = t;
      $('#date').textContent = WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
      renderStatus();                      // "data is old" can appear without a new poll
      renderPower();
      const day = Core.localDate(d);
      if (day !== lastDay) { lastDay = day; renderWeather(); }
    }
  }

  // ------------------------------------------------------------ rendering: weather
  function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

  function renderWeather() {
    const loc = state.location || Core.DEFAULT_LOCATION;
    $('#wxTitle').textContent = 'Weather · ' + loc.label;
    const w = state.weather;
    if (!w) return;

    const today = Core.localDate();
    const tomorrow = Core.localDate(new Date(Date.now() + 86400000));
    const days = w.days.filter((d) => d.date >= today).slice(0, 4);

    const n = w.now && w.now.temp !== null ? w.now : null;
    if (n) {
      const dsc = Core.describeWeather(n.code);
      $('#now').innerHTML = wxIcon(dsc.icon, n.isDay)
        + `<div class="temp">${Math.round(n.temp)}°</div>`
        + `<div class="desc"><div class="c">${esc(dsc.label)}</div>`
        + `<div class="s">${n.feels !== null ? 'Feels ' + Math.round(n.feels) + '°' : ''}${n.wind !== null ? ' · Wind ' + Math.round(n.wind) + ' km/h' : ''}</div></div>`;
    } else if (days[0]) {
      const dsc = Core.describeWeather(days[0].code);
      $('#now').innerHTML = wxIcon(dsc.icon, true) + `<div class="temp">${Math.round(days[0].max)}°</div><div class="desc"><div class="c">${esc(dsc.label)}</div><div class="s">Today's high</div></div>`;
    }

    const kWp = DEMO ? 5.5 : (state.plant && state.plant.kWp);
    $('#days').innerHTML = days.map((d) => {
      const dsc = Core.describeWeather(d.code);
      const dt = parseDay(d.date);
      const name = d.date === today ? 'Today' : d.date === tomorrow ? 'Tomorrow' : WEEKDAYS[dt.getDay()].slice(0, 3);
      const est = Core.estimateSolarKwh(kWp, d.radiationMJ);
      const sol = est !== null
        ? `<div class="sol"><span class="k">Solar estimate</span><span class="v">~${Math.round(est)} kWh</span></div>`
        : (d.sunHours !== null ? `<div class="sol"><span class="k">Sunshine</span><span class="v">${d.sunHours.toFixed(1)} h</span></div>` : '');
      const rain = d.rainProb === null ? '' : `<div class="row">${DROP}<span>${Math.round(d.rainProb)}%</span>${d.rainMm >= 0.1 ? '<span class="mm">' + d.rainMm.toFixed(1) + ' mm</span>' : ''}</div>`;
      const wind = d.windMax === null ? '' : `<div class="row">${WIND}<span>${Math.round(d.windMax)} km/h</span></div>`;
      const sunRow = est !== null && d.sunHours !== null ? `<div class="row">${SUNSM}<span>${d.sunHours.toFixed(1)} h sun</span></div>` : '';
      return `<div class="day">
          <div class="dn">${name}</div><div class="dd">${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)}</div>
          ${wxIcon(dsc.icon, true)}
          <div class="cond">${esc(dsc.label)}</div>
          <div class="hl">${d.max === null ? '—' : Math.round(d.max) + '°'} <span>${d.min === null ? '' : Math.round(d.min) + '°'}</span></div>
          ${rain}${wind}${sunRow}${sol}
        </div>`;
    }).join('');
  }

  // ------------------------------------------------------------ Sunsynk polling
  function friendlyError(e) {
    if (!e) return 'Something went wrong.';
    if (e.kind === 'auth' && e.detail && e.detail.code === 102) {
      return 'Sunsynk did not accept that email and password. Check them in the Sunsynk Connect app.';
    }
    if (e.kind === 'network') return 'Couldn’t reach Sunsynk. Check the tablet’s internet connection. (' + e.message + ')';
    return e.message || String(e);
  }

  function schedulePoll(ms) {
    clearTimeout(timers.poll);
    timers.poll = setTimeout(pollSunsynk, ms);
  }

  // Panel size, name and coordinates from Sunsynk's plant record. The weather follows
  // the system's own location unless someone has deliberately chosen another place.
  function applyPlantInfo(info) {
    if (!info || !state.plant) return;
    let changed = false;
    if (info.kWp && info.kWp !== state.plant.kWp) { state.plant.kWp = info.kWp; changed = true; }
    if (info.name && info.name !== state.plant.name) { state.plant.name = info.name; changed = true; }
    if (changed) store.set(K.plant, state.plant);
    if (!state.reportedAt && info.reportedAt) state.reportedAt = info.reportedAt;

    const loc = state.location || Core.DEFAULT_LOCATION;
    if (info.lat !== null && loc.source !== 'manual'
        && (Math.abs(info.lat - loc.lat) > 0.001 || Math.abs(info.lon - loc.lon) > 0.001 || loc.source !== 'plant')) {
      state.location = { lat: info.lat, lon: info.lon, label: info.town || loc.label, source: 'plant' };
      store.set(K.location, state.location);
      if ($('#setup').classList.contains('open')) renderLocation();
      pollWeather();
    }
    if (changed) renderWeather();
  }

  async function refreshTotals() {
    const id = state.plant.id;
    if (!state.plant.sn) {
      try {
        const sn = Core.firstInverterSn(await session.get(Core.paths.inverters(id)));
        if (sn) { state.plant.sn = sn; store.set(K.plant, state.plant); }
      } catch (e) { if (e.kind === 'auth') throw e; }
    }
    const sn = state.plant.sn;
    const jobs = { detail: session.get(Core.paths.plantDetail(id)) };
    if (sn) {
      jobs.pvInput = session.get(Core.paths.pvInput(sn));
      jobs.battery = session.get(Core.paths.battery(sn));
      jobs.grid = session.get(Core.paths.grid(sn));
      jobs.load = session.get(Core.paths.load(sn));
    }
    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(names.map((n) => jobs[n]));
    const parts = {};
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') parts[names[i]] = r.value;
      else if (r.reason && r.reason.kind === 'auth') throw r.reason;
    });
    if (parts.detail) {
      const info = Core.normalizePlantDetail(parts.detail);
      parts.plant = info.realtime;            // fallback for today's solar kWh
      applyPlantInfo(info);
    }
    // A part that failed this time keeps its previous value rather than blanking.
    const fresh = Core.normalizeTotals(parts);
    const prev = state.totals || {};
    const merged = {};
    for (const k of Object.keys(fresh)) merged[k] = fresh[k] !== null ? fresh[k] : (prev[k] ?? null);
    state.totals = merged;
  }

  async function pollSunsynk() {
    clearTimeout(timers.poll);
    if (DEMO) { applyDemo(); schedulePoll(6000); return; }
    if (!state.creds || !state.plant) { openSetup(); return; }
    if (polling) return;
    polling = true;
    try {
      const flow = Core.normalizeFlow(await session.get(Core.paths.flow(state.plant.id, Core.localDate())));
      if (!flow) throw new Core.SunsynkError('Sunsynk returned no live data', 'server');
      if (state.plant.sn) {
        try {
          const at = Core.inverterReportedAt(await session.get(Core.paths.inverter(state.plant.sn)));
          if (at) state.reportedAt = at;
        } catch (e) { if (e.kind === 'auth') throw e; /* the flow itself still arrived */ }
      }
      if (pollCount % Core.TOTALS_EVERY_N_POLLS === 0 || !state.totals) await refreshTotals();
      // A silent inverter comes back as all zeros. Those are "no data", not "nothing
      // flowing", so they never replace the last real reading.
      if (!Core.isSilent(state.reportedAt, Date.now())) { state.flow = flow; state.flowAt = Date.now(); }
      pollCount++;
      failCount = 0; lastFailed = false; nextRetryAt = null; lastErr = null;
      lastOkAt = Date.now();
      store.set(K.last, { plantId: state.plant.id, flow: state.flow, flowAt: state.flowAt, totals: state.totals, okAt: lastOkAt, reportedAt: state.reportedAt });
      renderPower(); renderStatus();
      schedulePoll(Core.POLL_MS);
    } catch (e) {
      console.warn('Sunsynk update failed:', e);
      failCount++; lastFailed = true; lastErr = e;
      const next = Core.decideAfterError(e, failCount);
      if (next.action === 'setup') {
        // Never retry a refused login on a timer — that is how accounts get locked.
        session.forget();
        renderStatus();
        openSetup(friendlyError(e));
      } else {
        nextRetryAt = Date.now() + next.delayMs;
        renderStatus(); renderPower();
        schedulePoll(next.delayMs);
      }
    } finally {
      polling = false;
    }
  }

  // ------------------------------------------------------------ weather polling
  async function pollWeather() {
    clearTimeout(timers.wx);
    if (DEMO) { state.weather = demoWeather(); renderWeather(); return; }
    const loc = state.location || Core.DEFAULT_LOCATION;
    try {
      const r = await fetch(Core.weatherUrl(loc.lat, loc.lon));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const w = Core.normalizeWeather(await r.json());
      if (!w) throw new Error('no forecast in the answer');
      state.weather = w;
      store.set(K.weather, { lat: loc.lat, lon: loc.lon, data: w, at: Date.now() });
      renderWeather();
      timers.wx = setTimeout(pollWeather, Core.WEATHER_MS);
    } catch (e) {
      console.warn('Weather update failed:', e);
      if (!state.weather) $('#now').innerHTML = '<span class="muted-note">The forecast is unavailable right now. Retrying shortly.</span>';
      timers.wx = setTimeout(pollWeather, 5 * 60 * 1000);
    }
  }

  // ------------------------------------------------------------ setup / settings
  let pendingLogin = null;

  function setMsg(text, kind) {
    const m = $('#setupMsg');
    m.textContent = text || '';
    m.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function openSetup(message) {
    const configured = !!(state.creds && state.plant);
    $('#user').value = state.creds ? state.creds.username : '';
    $('#pass').value = '';
    $('#pass').placeholder = state.creds ? 'Saved — leave blank to keep it' : '';
    $('#plantField').hidden = true;
    $('#signIn').textContent = configured ? 'Sign in again' : 'Sign in';
    $('#setupClose').hidden = !configured;
    $('#signOut').hidden = !state.creds;
    $('#setupIntro').textContent = configured
      ? 'Signed in as ' + state.creds.username + (state.plant ? ' · ' + state.plant.name : '') + '.'
      : 'Sign in with the same email and password as the Sunsynk Connect app.';
    pendingLogin = null;
    setMsg(message || '', message ? 'err' : '');
    renderLocation();
    $('#locResults').innerHTML = '';
    $('#appVersion').textContent = 'Version ' + APP_VERSION;
    $('#setup').classList.add('open');
    if (!configured) setTimeout(() => $('#user').focus(), 50);
  }

  function closeSetup() {
    $('#setup').classList.remove('open');
    pendingLogin = null;
  }

  function renderLocation() {
    const l = state.location || Core.DEFAULT_LOCATION;
    const why = l.source === 'plant' ? ', where your Sunsynk system is registered'
      : l.source === 'manual' ? ', chosen here' : '';
    $('#locNow').textContent = 'Showing the forecast for ' + l.label + why + ' (' + l.lat.toFixed(3) + ', ' + l.lon.toFixed(3) + ').';
    $('#locReset').hidden = !(l.source === 'manual' && state.plant);
  }

  async function useSystemLocation() {
    state.location = Object.assign({}, Core.DEFAULT_LOCATION);
    store.set(K.location, null);
    renderLocation();
    try { applyPlantInfo(Core.normalizePlantDetail(await session.get(Core.paths.plantDetail(state.plant.id)))); }
    catch (e) { pollWeather(); }
  }

  async function onSignIn() {
    const btn = $('#signIn');
    if (pendingLogin && !$('#plantField').hidden) {
      btn.disabled = true;
      try { await finishSetup(pendingLogin, $('#plant').value); } finally { btn.disabled = false; }
      return;
    }
    const username = $('#user').value.trim();
    let password = $('#pass').value;
    if (!password && state.creds && state.creds.username.toLowerCase() === username.toLowerCase()) password = state.creds.password;
    if (!username || !password) { setMsg('Enter the email and password.', 'err'); return; }

    btn.disabled = true;
    setMsg('Signing in…');
    try {
      const token = await Core.login((u, o) => fetch(u, o), username, password);
      const plants = Core.normalizePlants(await Core.authedGet((u, o) => fetch(u, o), token.accessToken, Core.paths.plants()));
      if (!plants.length) throw new Error('This Sunsynk account has no solar systems on it.');
      pendingLogin = { creds: { username, password }, token, plants };
      if (plants.length === 1) {
        await finishSetup(pendingLogin, plants[0].id);
      } else {
        const sel = $('#plant');
        sel.innerHTML = plants.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
        if (state.plant) sel.value = String(state.plant.id);
        $('#plantField').hidden = false;
        btn.textContent = 'Save';
        setMsg('This account has more than one system. Choose which one to show, then press Save.', 'ok');
      }
    } catch (e) {
      setMsg(friendlyError(e), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function finishSetup(p, plantId) {
    const plant = p.plants.find((x) => String(x.id) === String(plantId));
    if (!plant) { setMsg('Choose a system first.', 'err'); return; }
    setMsg('Loading the system…');
    const get = (path) => Core.authedGet((u, o) => fetch(u, o), p.token.accessToken, path);
    let sn = null, info = null;
    try { sn = Core.firstInverterSn(await get(Core.paths.inverters(plant.id))); } catch (e) { /* totals will retry */ }
    try { info = Core.normalizePlantDetail(await get(Core.paths.plantDetail(plant.id))); } catch (e) { /* totals will retry */ }
    const samePlant = state.plant && String(state.plant.id) === String(plant.id);
    state.creds = p.creds; store.set(K.creds, state.creds);
    state.token = p.token; store.set(K.token, state.token);
    state.plant = { id: plant.id, name: plant.name, kWp: plant.kWp, sn }; store.set(K.plant, state.plant);
    if (!samePlant) { state.flow = null; state.totals = null; state.reportedAt = null; lastOkAt = null; store.set(K.last, null); }
    applyPlantInfo(info);
    failCount = 0; lastFailed = false; pollCount = 0; nextRetryAt = null;
    closeSetup();
    renderStatus(); renderWeather();
    pollSunsynk();
    if (params.has('debug')) openDiagnostics();
  }

  function signOut() {
    if (!confirm('Sign out of Sunsynk on this tablet? The dashboard will stop until someone signs in again.')) return;
    clearTimeout(timers.poll);
    for (const k of [K.creds, K.token, K.plant, K.last]) store.set(k, null);
    state.creds = null; state.token = null; state.plant = null; state.flow = null; state.totals = null; state.reportedAt = null;
    session.forget(); lastOkAt = null; lastFailed = false;
    renderStatus(); renderPower();
    openSetup();
  }

  async function searchLocation() {
    const q = $('#locQuery').value.trim();
    const out = $('#locResults');
    if (!q) return;
    out.innerHTML = '<span class="fine">Searching…</span>';
    try {
      const r = await fetch(Core.geocodeUrl(q));
      const j = await r.json();
      const list = (j && j.results) || [];
      if (!list.length) { out.innerHTML = '<span class="fine">No places found. Try the town name.</span>'; return; }
      out.innerHTML = '';
      for (const p of list) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = [p.name, p.admin1, p.country].filter(Boolean).join(', ');
        b.addEventListener('click', () => {
          state.location = { lat: p.latitude, lon: p.longitude, label: p.name, source: 'manual' };
          store.set(K.location, state.location);
          out.innerHTML = '';
          $('#locQuery').value = '';
          renderLocation();
          state.weather = null;
          pollWeather();
        });
        out.appendChild(b);
      }
    } catch (e) {
      out.innerHTML = '<span class="fine">The place search is unavailable right now.</span>';
    }
  }

  // ------------------------------------------------------------ diagnostics
  async function runDiagnostics() {
    const out = $('#diagOut');
    if (DEMO) { out.textContent = 'Demo mode — no Sunsynk account is being used.'; return; }
    if (!state.creds || !state.plant) { out.textContent = 'Not signed in yet.'; return; }
    out.textContent = 'Asking Sunsynk…';
    const id = state.plant.id, sn = state.plant.sn;
    const asks = {
      plantDetail: Core.paths.plantDetail(id),
      inverters: Core.paths.inverters(id),
      flow: Core.paths.flow(id, Core.localDate()),
    };
    if (sn) Object.assign(asks, { inverter: Core.paths.inverter(sn), pvInput: Core.paths.pvInput(sn), battery: Core.paths.battery(sn), grid: Core.paths.grid(sn), load: Core.paths.load(sn) });
    const raw = {};
    for (const [name, path] of Object.entries(asks)) {
      try { raw[name] = await session.get(path); } catch (e) { raw[name] = { error: e.message, kind: e.kind }; }
    }
    const report = {
      app: {
        version: APP_VERSION,
        time: new Date().toString(),
        plant: state.plant,
        lastUpdate: lastOkAt ? new Date(lastOkAt).toString() : null,
        inverterLastReported: state.reportedAt ? new Date(state.reportedAt).toString() : null,
        status: dataStatusNow(),
        weatherLocation: state.location,
        lastError: lastErr ? String(lastErr.message || lastErr) : null,
        screenWakeLock: 'wakeLock' in navigator,
        browser: navigator.userAgent,
      },
      shown: { flow: displayFlow(), totals: state.totals },
      raw: Core.redact(raw),
    };
    out.textContent = JSON.stringify(report, null, 2);
  }
  function openDiagnostics() { $('#diag').classList.add('open'); runDiagnostics(); }

  // ------------------------------------------------------------ demo data
  function applyDemo() {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const sunUp = Math.max(0, Math.sin(((h - 6.5) / 12.5) * Math.PI));
    const jitter = () => 0.9 + Math.random() * 0.2;
    const pv = Math.round(5200 * sunUp * jitter());
    const load = Math.round(900 * jitter() + (h > 17 && h < 21 ? 1200 : 0));
    let batt = Math.min(3000, pv - load);
    let grid = 0;
    if (pv - load > 3000) grid = -(pv - load - 3000);
    if (h < 5 || h > 22) { batt = 0; grid = load; }
    state.flow = { pvW: pv, loadW: load, batteryW: batt, gridW: grid, soc: Math.round(40 + 55 * Math.min(1, Math.max(0, (h - 7) / 8))), hasGrid: true };
    state.totals = { pvKwh: 18.4, loadKwh: 11.2, battChargeKwh: 6.3, battDischargeKwh: 4.1, gridImportKwh: 0.6, gridExportKwh: 2.4 };
    lastOkAt = Date.now();
    renderPower(); renderStatus();
  }

  function demoWeather() {
    const day = (i) => Core.localDate(new Date(Date.now() + i * 86400000));
    return {
      now: { temp: 24.3, feels: 23.1, code: 2, wind: 14, isDay: true },
      days: [
        { date: day(0), code: 51, max: 25, min: 12, rainProb: 100, rainMm: 0.3, windMax: 22, sunHours: 3.0, radiationMJ: 8.5 },
        { date: day(1), code: 2, max: 24.5, min: 7.3, rainProb: 2, rainMm: 0, windMax: 25, sunHours: 12.5, radiationMJ: 26.1 },
        { date: day(2), code: 0, max: 30.7, min: 10.7, rainProb: 0, rainMm: 0, windMax: 24, sunHours: 12.5, radiationMJ: 25.7 },
        { date: day(3), code: 95, max: 28, min: 9.7, rainProb: 60, rainMm: 6.2, windMax: 31, sunHours: 6.1, radiationMJ: 15.2 },
      ],
    };
  }

  // ------------------------------------------------------------ keep the screen on, stay current
  let wakeLock = null;
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* not allowed yet — retried on the next tap or when the page is shown again */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    keepAwake();
    // Waking from sleep: refresh straight away rather than waiting for a timer that was paused.
    if (!DEMO && state.creds && state.plant && (!lastOkAt || Date.now() - lastOkAt > Core.POLL_MS) && !lastFailed) pollSunsynk();
    const wxAt = (store.get(K.weather) || {}).at || 0;
    if (Date.now() - wxAt > Core.WEATHER_MS) pollWeather();
    checkForUpdate();
  });
  document.addEventListener('pointerdown', keepAwake, { passive: true });

  // A new version published to the host reaches the tablet without anyone touching it.
  async function checkForUpdate() {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = await r.json();
      if (v && v.version && v.version !== APP_VERSION) location.reload();
    } catch (e) { /* offline: try again later */ }
  }

  // ------------------------------------------------------------ settings button (press and hold)
  function wireGear() {
    const gear = $('#gear');
    let hold = null;
    const cancel = (showHint) => {
      if (!hold) return;
      clearTimeout(hold); hold = null;
      gear.classList.remove('holding');
      if (showHint) {
        const h = $('#hint');
        h.classList.add('show');
        setTimeout(() => h.classList.remove('show'), 1800);
      }
    };
    gear.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gear.classList.add('holding');
      hold = setTimeout(() => { hold = null; gear.classList.remove('holding'); openSetup(); }, 700);
    });
    gear.addEventListener('pointerup', () => cancel(true));
    gear.addEventListener('pointerleave', () => cancel(false));
    gear.addEventListener('pointercancel', () => cancel(false));
    gear.addEventListener('contextmenu', (e) => e.preventDefault());
    gear.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSetup(); } });
  }

  // ------------------------------------------------------------ start
  function start() {
    buildFlow();
    wireGear();
    $('#signIn').addEventListener('click', onSignIn);
    $('#pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSignIn(); });
    $('#showPass').addEventListener('click', () => {
      const p = $('#pass');
      p.type = p.type === 'password' ? 'text' : 'password';
      $('#showPass').textContent = p.type === 'password' ? 'Show' : 'Hide';
    });
    $('#setupClose').addEventListener('click', closeSetup);
    $('#signOut').addEventListener('click', signOut);
    $('#locSearch').addEventListener('click', searchLocation);
    $('#locReset').addEventListener('click', useSystemLocation);
    $('#locQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchLocation(); });
    $('#openDiag').addEventListener('click', openDiagnostics);
    $('#diagRefresh').addEventListener('click', runDiagnostics);
    $('#diagClose').addEventListener('click', () => $('#diag').classList.remove('open'));

    tickClock();
    setInterval(tickClock, 1000);
    renderStatus();
    renderPower();
    renderTotals(false);
    renderWeather();

    pollWeather();
    if (DEMO || (state.creds && state.plant)) {
      pollSunsynk();
      if (params.has('debug') && !DEMO) openDiagnostics();
    } else {
      openSetup();
    }
    if (params.has('setup') && !DEMO) openSetup();

    keepAwake();
    setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  start();
})();
