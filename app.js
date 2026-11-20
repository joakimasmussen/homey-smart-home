(() => {
  'use strict';
  const C = window.APP_CONFIG;
  const DEMO = new URLSearchParams(location.search).has('demo') || window.HOME_DEMO === true;
  const ATHOM = 'https://api.athom.com';
  const TZ = 'Europe/Copenhagen';
  const $ = (id) => document.getElementById(id);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('home.' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('home.' + k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
    del(k) { try { localStorage.removeItem('home.' + k); } catch (e) { /* storage off */ } },
  };
  const mem = {};
  const getS = (k) => (DEMO ? mem[k] ?? null : store.get(k));
  const setS = (k, v) => (DEMO ? (mem[k] = v) : store.set(k, v));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const f2 = (v) => (num(v) == null ? '—' : v.toFixed(2));
  const f1 = (v) => (num(v) == null ? '—' : v.toFixed(1));

  const state = { tab: 'home', zone: 'all', zones: {}, devices: {}, prices: [], homey: null };

  // ---------- time helpers (Danish time) ----------
  function partsDK(d) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return p;
  }
  function dayKey(offsetDays = 0) { const p = partsDK(new Date(Date.now() + offsetDays * 86400000)); return `${p.year}-${p.month}-${p.day}`; }
  function nowKey() { const p = partsDK(new Date()); return `${p.year}-${p.month}-${p.day}T${p.hour}:${String(Math.floor(+p.minute / 15) * 15).padStart(2, '0')}`; }
  function nowHour() { return +partsDK(new Date()).hour; }
  function nowLabel() { return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date()); }

  // ---------- theme ----------
  function applyTheme() {
    const t = (DEMO ? mem.theme : store.get('theme')) || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('theme-select').value = t;
  }

  // ---------- network ----------
  function withTimeout(promiseFn, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return promiseFn(ctl.signal).finally(() => clearTimeout(timer));
  }

  async function tokenRequest(params) {
    const body = new URLSearchParams({ client_id: C.clientId, client_secret: C.clientSecret, ...params });
    const r = await fetch(ATHOM + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!r.ok) throw new Error('sign-in was refused (' + r.status + ')');
    const t = await r.json();
    t.expires_at = Date.now() + (t.expires_in || 3600) * 1000 - 60000;
    store.set('oauth', t);
    return t;
  }
  async function accessToken() {
    let t = store.get('oauth');
    if (!t) throw new Error('not signed in');
    if (Date.now() > t.expires_at && t.refresh_token) t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    return t.access_token;
  }
  async function athom(path, opts = {}) {
    const r = await fetch(ATHOM + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + (await accessToken()) } });
    if (!r.ok) throw new Error('Homey account ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }

  async function connectHomey(force) {
    let s = store.get('homey');
    if (s && !force) { state.homey = s; return s; }
    const me = await athom('/user/me');
    const list = me.homeys || [];
    const h = list.find((x) => /pro/i.test(String(x.model || x.platform || ''))) || list[0];
    if (!h) throw new Error('no Homey found on this account');
    const candidates = [h.localUrlSecure, h.remoteUrlForwarded, h.remoteUrl].filter(Boolean);
    let lastErr = null;
    for (const base of candidates) {
      try {
        let del = await athom('/delegation/token?audience=homey', { method: 'POST' });
        if (del && typeof del === 'object' && del.token) del = del.token;
        const r = await withTimeout((signal) => fetch(base + '/api/manager/users/login', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: del }) }), base === h.localUrlSecure ? 3000 : 15000);
        if (!r.ok) throw new Error('Homey login ' + r.status);
        let session = await r.json();
        if (session && typeof session === 'object' && session.token) session = session.token;
        s = { base, session, name: h.name, local: h.localUrlSecure || null, remote: h.remoteUrlForwarded || h.remoteUrl || null };
        store.set('homey', s);
        state.homey = s;
        return s;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('could not reach your Homey');
  }

  async function homey(path, retried) {
    const s = state.homey;
    try {
      const r = await withTimeout((signal) => fetch(s.base + path, { signal, headers: { Authorization: 'Bearer ' + s.session } }), 15000);
      if (r.status === 401 && !retried) { await connectHomey(true); return homey(path, true); }
      if (!r.ok) throw new Error('Homey ' + r.status);
      return r.json();
    } catch (e) {
      // Left home: the local address stops working, so switch to the remote one.
      if (!retried && s.remote && s.base !== s.remote) { s.base = s.remote; store.set('homey', s); return homey(path, true); }
      if (!retried && s.local && s.base !== s.local) {
        const back = { ...s, base: s.local };
        try { state.homey = back; const res = await homey(path, true); store.set('homey', back); return res; } catch (e2) { state.homey = s; }
      }
      throw e;
    }
  }

  // ---------- prices ----------
  function gridAt(h) { return (C.tariffs.grid.find((g) => h >= g.from && h < g.to) || { kr: 0 }).kr; }
  function withAllIn(p) {
    const T = C.tariffs;
    const h = +p.t.slice(11, 13);
    const grid = gridAt(h);
    const other = T.energinet + T.supplierMarkup + T.elafgift;
    const vat = (p.spot + grid + other) * T.vat;
    return { ...p, grid, other, vat, total: p.spot + grid + other + vat };
  }
  // Energi Data Service first (15-minute prices); it may refuse browser requests, so fall back to
  // elprisenligenu.dk, which serves the same day-ahead prices with browser access allowed.
  async function fromEnergiDataService(start, end) {
    const url = 'https://api.energidataservice.dk/dataset/DayAheadPrices?start=' + start + 'T00:00&end=' + end + 'T00:00&filter=' + encodeURIComponent(JSON.stringify({ PriceArea: [C.priceArea] })) + '&sort=TimeDK%20asc&limit=400';
    const r = await withTimeout((signal) => fetch(url, { signal }), 15000);
    if (!r.ok) throw new Error('prices ' + r.status);
    const j = await r.json();
    return (j.records || []).filter((x) => x.DayAheadPriceDKK != null).map((x) => ({ t: x.TimeDK.slice(0, 16), spot: x.DayAheadPriceDKK / 1000 }));
  }
  async function fromElprisenLigeNu(day) {
    const url = 'https://www.elprisenligenu.dk/api/v1/prices/' + day.slice(0, 4) + '/' + day.slice(5, 7) + '-' + day.slice(8, 10) + '_' + C.priceArea + '.json';
    const r = await withTimeout((signal) => fetch(url, { signal }), 15000);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('prices ' + r.status);
    const out = [];
    for (const x of await r.json()) {
      const a = new Date(x.time_start).getTime(), b = new Date(x.time_end).getTime();
      for (let t = a; t < b; t += 15 * 60000) {
        const p = partsDK(new Date(t));
        out.push({ t: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, spot: x.DKK_per_kWh });
      }
    }
    return out;
  }
  async function loadPrices() {
    const start = dayKey(0), end = dayKey(2);
    let raw;
    try { raw = await fromEnergiDataService(start, end); }
    catch (e) { raw = (await fromElprisenLigeNu(start)).concat(await fromElprisenLigeNu(dayKey(1)).catch(() => [])); }
    state.prices = raw.map(withAllIn);
    state.pricesDay = start;
    setS('prices', { day: start, list: state.prices });
  }
  function hourly(day) {
    const out = [];
    for (let h = 0; h < 24; h++) {
      const key = day + 'T' + String(h).padStart(2, '0');
      const q = state.prices.filter((p) => p.t.startsWith(key));
      out.push(q.length ? { h, total: q.reduce((a, p) => a + p.total, 0) / q.length } : { h, total: null });
    }
    return out;
  }
  function levelFn(today) {
    const v = today.map((x) => x.total).filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return () => 'mid';
    const lo = v[Math.floor(v.length / 3)], hi = v[Math.floor((v.length * 2) / 3)];
    return (p) => (p == null ? 'mid' : p <= lo ? 'cheap' : p >= hi ? 'peak' : 'mid');
  }

  // ---------- devices ----------
  const ICONS = {
    light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z"></path>',
    socket: '<rect x="4" y="4" width="16" height="16" rx="4"></rect><path d="M10 10v2M14 10v2M9.5 15h5"></path>',
    temp: '<path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0z"></path>',
    door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16M14 12h.01"></path>',
    motion: '<circle cx="12" cy="5" r="2"></circle><path d="M10 22l2-7 3 3v4M7 13l3-4h4l2 3"></path>',
    blinds: '<path d="M4 4h16M5 4v15M19 4v15M8 8h8M8 12h8M8 16h8"></path>',
    speaker: '<rect x="6" y="3" width="12" height="18" rx="2"></rect><circle cx="12" cy="14" r="3"></circle><path d="M12 7h.01"></path>',
    button: '<circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"></path>',
    dot: '<circle cx="12" cy="12" r="4"></circle>',
  };
  function iconFor(d) {
    const c = d.capabilitiesObj || {};
    if (d.class === 'light') return 'light';
    if (d.class === 'socket') return 'socket';
    if (d.class === 'windowcoverings' || 'windowcoverings_set' in c || 'windowcoverings_state' in c) return 'blinds';
    if (d.class === 'speaker') return 'speaker';
    if (d.class === 'button' || d.class === 'remote') return 'button';
    if ('alarm_contact' in c) return 'door';
    if ('alarm_motion' in c) return 'motion';
    if ('measure_temperature' in c) return 'temp';
    if ('onoff' in c) return 'light';
    if ('measure_power' in c) return 'bolt';
    return 'dot';
  }
  function tileInfo(d) {
    const c = d.capabilitiesObj || {};
    const v = (k) => (c[k] ? c[k].value : null);
    let main = '', sub = '', on = false, alert = false;
    if ('onoff' in c) {
      on = v('onoff') === true;
      main = on ? 'On' : 'Off';
      if (on && num(v('dim')) != null) main = Math.round(v('dim') * 100) + ' %';
      if (num(v('measure_power')) != null) sub = Math.round(v('measure_power')) + ' W';
    } else if ('measure_temperature' in c) {
      main = f1(v('measure_temperature')) + '°';
      if (num(v('measure_humidity')) != null) sub = Math.round(v('measure_humidity')) + ' %';
    } else if ('alarm_contact' in c) {
      alert = v('alarm_contact') === true; main = alert ? 'Open' : 'Closed';
    } else if ('alarm_motion' in c) {
      alert = v('alarm_motion') === true; main = alert ? 'Motion' : 'Clear';
    } else if ('windowcoverings_set' in c) {
      const x = v('windowcoverings_set'); main = num(x) == null ? '—' : x >= 0.99 ? 'Up' : x <= 0.01 ? 'Down' : Math.round(x * 100) + ' %';
    } else if ('windowcoverings_state' in c) {
      main = { up: 'Up', down: 'Down', idle: 'Stopped' }[v('windowcoverings_state')] || '—';
    } else if ('measure_power' in c) {
      main = num(v('measure_power')) == null ? '—' : Math.round(v('measure_power')) + ' W';
    }
    if (!main && (d.class === 'button' || d.class === 'remote')) main = 'Button';
    if (!main && num(v('measure_battery')) != null) main = Math.round(v('measure_battery')) + ' % battery';
    if (d.available === false) { main = 'Unavailable'; on = false; }
    return { main: main || '—', sub, on, alert };
  }
  function deviceList() {
    return Object.values(state.devices).filter((d) => !d.hidden).sort((a, b) => zoneName(a.zone).localeCompare(zoneName(b.zone)) || String(a.name).localeCompare(String(b.name)));
  }
  function zoneName(id) { return (state.zones[id] && state.zones[id].name) || ''; }

  function tileHTML(d, showZone) {
    const t = tileInfo(d);
    const cls = 'tile' + (t.on ? ' on' : '') + (t.alert ? ' alert' : '');
    return '<article class="' + cls + '">' +
      '<div class="tile-top"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[iconFor(d)] + '</svg>' +
      '<span class="' + (t.on ? '' : 'muted') + '">' + esc(t.sub) + '</span></div>' +
      '<div><div class="tile-name">' + esc(d.name) + '</div>' +
      '<div class="tile-zone muted">' + esc(t.main) + (showZone && zoneName(d.zone) ? ' · ' + esc(zoneName(d.zone)) : '') + '</div></div>' +
      '</article>';
  }

  // ---------- render ----------
  function render() {
    $('now-label').textContent = nowLabel();
    renderPrices();
    renderHouse();
    renderHeat();
    if (state.tab === 'devices') renderZoneGroups();
    if (state.tab === 'energy') renderEnergy();
  }

  function renderPrices() {
    const today = dayKey(0), tomorrow = dayKey(1);
    const hrs = hourly(today);
    const lvl = levelFn(hrs);
    const now = state.prices.find((p) => p.t === nowKey());
    const h = nowHour();
    $('tariff-note').hidden = !C.tariffs.sample;
    if (!now) {
      $('price-now').textContent = '—';
      $('level-pill').textContent = state.prices.length ? 'No price for now' : 'Loading prices';
      $('level-pill').className = 'pill';
    } else {
      $('price-now').textContent = f2(now.total);
      const L = lvl(hrs[h].total);
      $('level-pill').textContent = L === 'peak' ? 'Peak hours' : L === 'cheap' ? 'Cheap now' : 'Normal';
      $('level-pill').className = 'pill' + (L === 'mid' ? '' : ' ' + L);
    }
    const max = Math.max(1, ...hrs.map((x) => x.total || 0));
    $('bars').innerHTML = hrs.map((x) => {
      const ht = x.total == null ? 4 : Math.max(4, Math.round((x.total / max) * 72));
      const cls = 'bar ' + lvl(x.total) + (x.h < h ? ' past' : '') + (x.h === h ? ' now' : '');
      return '<div class="' + cls + '" style="height:' + ht + 'px"></div>';
    }).join('');
    // cheapest next hour, from the next hour on, today and tomorrow
    const ahead = hrs.filter((x) => x.h > h && x.total != null).map((x) => ({ ...x, day: 'today' }))
      .concat(hourly(tomorrow).filter((x) => x.total != null).map((x) => ({ ...x, day: 'tomorrow' })));
    if (ahead.length) {
      const best = ahead.reduce((a, b) => (b.total < a.total ? b : a));
      $('next-cheap-text').innerHTML = 'Cheapest next at <b>' + String(best.h).padStart(2, '0') + ':00</b>' + (best.day === 'tomorrow' ? ' tomorrow' : '');
      $('next-cheap-price').textContent = f2(best.total) + ' kr';
    } else {
      $('next-cheap-text').textContent = 'Tomorrow’s prices arrive around 13:00';
      $('next-cheap-price').textContent = '';
    }
  }

  function renderHouse() {
    const devs = Object.values(state.devices);
    const power = devs.map((d) => d.capabilitiesObj && d.capabilitiesObj.measure_power && d.capabilitiesObj.measure_power.value).filter((v) => num(v) != null);
    if (power.length) {
      $('house-power').textContent = f1(power.reduce((a, b) => a + b, 0) / 1000);
      $('house-power-note').textContent = 'From ' + power.length + ' meter' + (power.length > 1 ? 's' : '');
    } else {
      $('house-power').textContent = '—';
      $('house-power-note').textContent = 'Add PowerTags to see this';
    }
    const temps = devs.filter((d) => d.capabilitiesObj && d.capabilitiesObj.measure_temperature && num(d.capabilitiesObj.measure_temperature.value) != null);
    if (temps.length) {
      const avg = temps.reduce((a, d) => a + d.capabilitiesObj.measure_temperature.value, 0) / temps.length;
      $('inside-temp').textContent = f1(avg);
      $('inside-note').textContent = temps.length === 1 ? temps[0].name : 'Average of ' + temps.length + ' sensors';
    } else {
      $('inside-temp').textContent = '—';
      $('inside-note').textContent = 'No temperature sensors';
    }
  }

  function renderChips() {
    const used = new Set(deviceList().map((d) => d.zone));
    const zones = Object.values(state.zones).filter((z) => used.has(z.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (state.zone !== 'all' && !used.has(state.zone)) state.zone = 'all';
    const chips = [{ id: 'all', name: 'All' }].concat(zones);
    $('zone-chips').innerHTML = chips.map((z) => '<button type="button" class="chip" data-zone="' + esc(z.id) + '" aria-pressed="' + (state.zone === z.id) + '">' + esc(z.name) + '</button>').join('');
  }

  function renderHomeDevices() {
    const list = deviceList().filter((d) => state.zone === 'all' || d.zone === state.zone);
    $('home-devices').innerHTML = list.length ? list.map((d) => tileHTML(d, state.zone === 'all')).join('') : '<p class="muted small">No devices yet.</p>';
  }

  function renderZoneGroups() {
    const groups = {};
    deviceList().forEach((d) => { (groups[d.zone] = groups[d.zone] || []).push(d); });
    const ids = Object.keys(groups).sort((a, b) => zoneName(a).localeCompare(zoneName(b)));
    $('zone-groups').innerHTML = ids.map((id) => '<section class="zone-group"><h2 class="zone-title">' + esc(zoneName(id) || 'Other') + '</h2><div class="tiles">' + groups[id].map((d) => tileHTML(d, false)).join('') + '</div></section>').join('') || '<p class="muted">No devices yet.</p>';
  }

  function renderEnergy() {
    const now = state.prices.find((p) => p.t === nowKey());
    const T = C.tariffs;
    const s = T.sample ? ' (sample)' : '';
    if (now) {
      const rows = [['Spot price, ' + C.priceArea, now.spot], ['Grid tariff' + s, now.grid], ['Energinet' + s, T.energinet], ['Supplier markup' + s, T.supplierMarkup], ['Elafgift', T.elafgift], ['VAT 25 %', now.vat]];
      $('breakdown').innerHTML = rows.map((r) => '<div class="row-between"><span>' + esc(r[0]) + '</span><span>' + f2(r[1]) + '</span></div>').join('') +
        '<div class="row-between total"><span>Total</span><span>' + f2(now.total) + ' kr/kWh</span></div>';
    } else {
      $('breakdown').innerHTML = '<p class="muted small">No price for this quarter yet.</p>';
    }
    const list = (day, el, isToday) => {
      const hrs = hourly(day).filter((x) => x.total != null);
      if (!hrs.length) { $(el).innerHTML = '<p class="muted small">' + (isToday ? 'No prices.' : 'Published around 13:00.') + '</p>'; return; }
      const lvl = levelFn(hrs);
      const max = Math.max(...hrs.map((x) => x.total));
      const h = nowHour();
      $(el).innerHTML = hrs.map((x) => '<div class="hour-row' + (isToday && x.h === h ? ' now' : '') + (isToday && x.h < h ? ' past' : '') + '"><span>' + String(x.h).padStart(2, '0') + ':00</span><span class="track"><span class="fill ' + lvl(x.total) + '" style="display:block;width:' + Math.round((x.total / max) * 100) + '%"></span></span><span class="price">' + f2(x.total) + '</span></div>').join('');
    };
    list(dayKey(0), 'list-today', true);
    list(dayKey(1), 'list-tomorrow', false);
  }

  // ---------- How the house holds heat ----------
  state.heat = { outside: null, hist: {}, source: null };
  const DAY = 24 * 3600000;

  function floorDevices(key) {
    const names = ((C.floors && C.floors[key] && C.floors[key].devices) || []).map((n) => n.trim().toLowerCase());
    return Object.values(state.devices).filter((d) => names.includes(String(d.name).trim().toLowerCase()) && d.capabilitiesObj && d.capabilitiesObj.measure_temperature);
  }
  function floorNow(key) {
    const v = floorDevices(key).map((d) => d.capabilitiesObj.measure_temperature.value).filter((x) => num(x) != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  async function loadOutside() {
    const L = C.location || { lat: 56.14, lon: 8.97 };
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + L.lat + '&longitude=' + L.lon + '&current=temperature_2m&hourly=temperature_2m&past_days=1&forecast_days=1&timezone=Europe%2FCopenhagen';
    const r = await withTimeout((signal) => fetch(url, { signal }), 15000);
    if (!r.ok) throw new Error('weather ' + r.status);
    const j = await r.json();
    const now = Date.now();
    const series = j.hourly.time.map((t, i) => ({ t: new Date(t).getTime(), v: j.hourly.temperature_2m[i] })).filter((p) => p.t >= now - DAY && p.t <= now && num(p.v) != null);
    state.heat.outside = { now: j.current ? j.current.temperature_2m : (series.length ? series[series.length - 1].v : null), series };
  }

  // Homey Insights: try the two address forms the Web API uses for a log's entries.
  async function insightSeries(deviceId) {
    const full = 'homey:device:' + deviceId + ':measure_temperature';
    const paths = [
      '/api/manager/insights/log/' + encodeURIComponent(full) + '/entry?resolution=last24Hours',
      '/api/manager/insights/log/' + encodeURIComponent('homey:device:' + deviceId) + '/measure_temperature/entry?resolution=last24Hours',
    ];
    for (const p of paths) {
      try {
        const r = await homey(p, true);
        const vals = (r && (r.values || r.entries)) || r;
        if (Array.isArray(vals) && vals.length) {
          return vals.map((x) => ({ t: new Date(x.t || x.time || x.date).getTime(), v: x.v != null ? x.v : x.value })).filter((x) => num(x.v) != null && isFinite(x.t));
        }
      } catch (e) { /* try the next form */ }
    }
    return null;
  }

  // Fallback history kept on this phone, one reading per floor every 10 minutes.
  function logLocal() {
    const log = getS('heatlog') || { ground: [], first: [] };
    const now = Date.now();
    ['ground', 'first'].forEach((k) => {
      const v = floorNow(k);
      const arr = log[k] || [];
      if (num(v) != null && (!arr.length || now - arr[arr.length - 1].t > 10 * 60000)) arr.push({ t: now, v });
      log[k] = arr.filter((p) => p.t > now - DAY);
    });
    setS('heatlog', log);
    return log;
  }

  async function loadIndoor() {
    let gotInsights = false;
    for (const k of ['ground', 'first']) {
      const devs = floorDevices(k);
      if (!devs.length) { state.heat.hist[k] = null; continue; }
      const series = await insightSeries(devs[0].id);
      if (series && series.length) { state.heat.hist[k] = series.filter((p) => p.t >= Date.now() - DAY); gotInsights = true; }
    }
    state.heat.source = gotInsights ? 'insights' : 'local';
  }

  async function loadHeat() {
    try { await loadOutside(); } catch (e) { /* show without outside */ }
    if (!DEMO && state.homey) { try { await loadIndoor(); } catch (e) { state.heat.source = 'local'; } }
    renderHeat();
  }

  function seriesFor(k) {
    if (state.heat.source === 'insights' || DEMO) return state.heat.hist[k] || [];
    return ((getS('heatlog') || {})[k]) || [];
  }
  function change(series, now) {
    if (!series || series.length < 2 || num(now) == null) return null;
    if (series[series.length - 1].t - series[0].t < 6 * 3600000) return null;
    return now - series[0].v;
  }
  const signed = (d) => (d == null ? '' : (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(1) + '°');

  function renderHeat() {
    if (!$('heat-card')) return;
    if (!DEMO) logLocal();
    const g = floorNow('ground'), f = floorNow('first');
    const out = state.heat.outside;
    const sg = seriesFor('ground'), sf = seriesFor('first'), so = out ? out.series : [];
    const cg = change(sg, g), cf = change(sf, f), co = out ? change(so, out.now) : null;
    $('heat-ground').textContent = g == null ? '—' : f1(g) + '°';
    $('heat-first').textContent = f == null ? '—' : f1(f) + '°';
    $('heat-out').textContent = out && num(out.now) != null ? f1(out.now) + '°' : '—';
    const dl = (el, d) => { $(el).textContent = d == null ? 'Collecting 24 h' : signed(d) + ' in 24 h'; $(el).className = 'muted tiny-label' + (d != null && d <= -0.8 ? ' delta-bad' : ''); };
    dl('heat-ground-d', cg); dl('heat-first-d', cf);
    $('heat-out-d').textContent = co == null ? (C.location ? C.location.name : '') : signed(co) + ' in 24 h';
    $('heat-out-label').textContent = 'Outside' + (C.location ? ', ' + C.location.name : '');

    const badge = $('heat-badge');
    if (cg == null || cf == null) { badge.textContent = 'Learning'; badge.className = 'pill'; }
    else if (Math.max(-cg, -cf) < 0.6) { badge.textContent = 'Holds well'; badge.className = 'pill good'; }
    else { badge.textContent = (cf < cg ? '1st floor' : 'Ground floor') + ' cools faster'; badge.className = 'pill warn'; }

    const parts = [];
    if (g != null && f != null) {
      const d = g - f;
      parts.push(Math.abs(d) < 0.3 ? 'Both floors are about the same temperature.' : (d > 0 ? 'Upstairs is ' : 'Upstairs is ') + '<b>' + Math.abs(d).toFixed(1) + '°</b> ' + (d > 0 ? 'cooler' : 'warmer') + ' than downstairs.');
    } else if (g == null && f == null) {
      parts.push('No floor sensors found. Check the sensor names in config.js.');
    }
    if (cg != null && cf != null && co != null) {
      const minOut = Math.min(...so.map((p) => p.v));
      parts.push('Since this time yesterday it got <b>' + Math.abs(co).toFixed(1) + '°</b> ' + (co < 0 ? 'colder' : 'warmer') + ' outside (lowest ' + f1(minOut) + '°). The 1st floor changed <b>' + signed(cf) + '</b> and the ground floor <b>' + signed(cg) + '</b>.');
    } else {
      parts.push(state.heat.source === 'local' ? 'Building up 24 hours of history on this phone; the comparison appears tomorrow.' : 'Collecting the last 24 hours…');
    }
    $('heat-summary').innerHTML = parts.join(' ');
    drawHeat(sg, sf, so);
  }

  function drawHeat(sg, sf, so) {
    const el = $('heat-chart');
    const W = Math.max(240, el.clientWidth), H = 150, l = 34, r = 6;
    const now = Date.now(), t0 = now - DAY;
    const x = (t) => l + ((t - t0) / DAY) * (W - l - r);
    const fmtT = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
    // one small panel per scale: the two floors share a tight scale, outside gets its own
    const panel = (series, top, h, minSpan) => {
      const vals = series.flatMap((s) => s.list.map((p) => p.v)).filter((v) => num(v) != null);
      if (!vals.length) return '';
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = Math.max(0.2, (minSpan - (hi - lo)) / 2);
      lo -= pad; hi += pad;
      const y = (v) => top + (1 - (v - lo) / (hi - lo)) * h;
      const labs = [hi, lo].map((v) => '<text x="' + (l - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + v.toFixed(Math.abs(hi - lo) < 4 ? 1 : 0) + '°</text>').join('');
      const box = '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + top + '" y2="' + top + '" stroke="var(--line)"></line><line x1="' + l + '" x2="' + (W - r) + '" y1="' + (top + h) + '" y2="' + (top + h) + '" stroke="var(--line)"></line>';
      const lines = series.map((s) => (s.list.length > 1 ? '<polyline fill="none" stroke="' + s.color + '" stroke-width="' + s.w + '" stroke-linejoin="round"' + (s.dash ? ' stroke-dasharray="4 4"' : '') + ' points="' + s.list.filter((p) => p.t >= t0).map((p) => x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' ') + '"></polyline>' : '')).join('');
      return box + labs + lines;
    };
    const inside = panel([{ list: sf, color: 'var(--first)', w: 2.5 }, { list: sg, color: 'var(--ground)', w: 2.5 }], 6, 62, 2);
    const outside = panel([{ list: so, color: 'var(--out)', w: 2, dash: true }], 86, 40, 4);
    const hours = [24, 18, 12, 6, 0].map((h) => { const t = now - h * 3600000; return '<text x="' + x(t).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' + (h === 24 ? 'start' : h === 0 ? 'end' : 'middle') + '">' + (h === 0 ? 'now' : fmtT(t)) + '</text>'; }).join('');
    el.innerHTML = inside || outside ? '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + inside + outside + hours + '</svg>' : '';
  }

  // ---------- UI ----------
  function setStatus(msg) { $('status').hidden = !msg; $('status').textContent = msg || ''; }
  function showLogin(err) { $('login').hidden = false; $('main').hidden = true; $('login-error').hidden = !err; $('login-error').textContent = err ? 'Could not sign in: ' + err : ''; }
  function showMain() { $('login').hidden = true; $('main').hidden = false; }
  function switchTab(tab) {
    state.tab = tab;
    ['home', 'energy', 'devices', 'history'].forEach((t) => { $('tab-' + t).hidden = t !== tab; });
    document.querySelectorAll('.tabbtn').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('page-title').textContent = { home: 'Home', energy: 'Energy', devices: 'Devices', history: 'History' }[tab];
    render();
    window.scrollTo(0, 0);
  }
  function openSheet(open) { $('sheet').hidden = !open; $('sheet-backdrop').hidden = !open; if (open && state.homey) $('homey-name').textContent = 'Connected to ' + (state.homey.name || 'your Homey'); }

  function wireUI() {
    $('login-btn').addEventListener('click', () => {
      location.href = ATHOM + '/oauth2/authorise?client_id=' + encodeURIComponent(C.clientId) + '&redirect_uri=' + encodeURIComponent(C.redirectUri) + '&response_type=code';
    });
    document.querySelectorAll('.tabbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('settings-btn').addEventListener('click', () => openSheet(true));
    $('sheet-close').addEventListener('click', () => openSheet(false));
    $('sheet-backdrop').addEventListener('click', () => openSheet(false));
    $('theme-select').addEventListener('change', (e) => { if (DEMO) mem.theme = e.target.value; else store.set('theme', e.target.value); applyTheme(); });
    $('logout-btn').addEventListener('click', () => { ['oauth', 'homey'].forEach((k) => store.del(k)); openSheet(false); state.devices = {}; showLogin(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
    let rz = null;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderHeat, 150); });
  }

  // ---------- loops ----------
  let busy = false;
  async function tick(full) {
    if (busy || document.hidden) return;
    busy = true;
    try {
      if (!DEMO && state.homey) {
        state.devices = await homey('/api/manager/devices/device/');
        if (full) state.zones = await homey('/api/manager/zones/zone/');
        setStatus(null);
      }
    } catch (e) { setStatus('Lost contact with your Homey. Retrying…'); }
    try { if (!DEMO && state.pricesDay !== dayKey(0)) await loadPrices(); } catch (e) { /* keep old prices */ }
    if (!DEMO) {
      const hasTomorrow = state.prices.some((p) => p.t.startsWith(dayKey(1)));
      if (!hasTomorrow && nowHour() >= 13 && (!state.lastPriceTry || Date.now() - state.lastPriceTry > 30 * 60000)) { state.lastPriceTry = Date.now(); loadPrices().then(render).catch(() => {}); }
    }
    busy = false;
    render();
  }

  async function boot() {
    wireUI();
    applyTheme();
    if (DEMO) {
      window.HOME_DEMO_DATA(state, dayKey(0));
      showMain();
      setStatus('Demo: sample devices and today’s prices. Sign-in and live data work on the real address.');
      render();
      loadHeat();
      setInterval(() => render(), 60000);
      return;
    }
    const q = new URLSearchParams(location.search);
    if (q.get('error')) { showLogin(q.get('error_description') || q.get('error')); history.replaceState(null, '', location.pathname); return; }
    if (q.get('code')) {
      try { await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: C.redirectUri }); }
      catch (e) { showLogin(e.message); history.replaceState(null, '', location.pathname); return; }
      history.replaceState(null, '', location.pathname);
    }
    if (!store.get('oauth')) { showLogin(); return; }
    showMain();
    const cached = store.get('prices');
    if (cached && cached.day === dayKey(0)) { state.prices = cached.list; state.pricesDay = cached.day; }
    render();
    setStatus('Connecting to your Homey…');
    try {
      await connectHomey();
      state.zones = await homey('/api/manager/zones/zone/');
      state.devices = await homey('/api/manager/devices/device/');
      setStatus(null);
    } catch (e) {
      setStatus('Could not reach your Homey (' + e.message + '). Try signing out and in again from Settings.');
    }
    loadPrices().then(render).catch(() => { if (!state.prices.length) setStatus('Electricity prices could not be loaded right now.'); });
    render();
    loadHeat();
    setInterval(loadHeat, 10 * 60000);
    setInterval(() => tick(false), (C.refreshSeconds || 15) * 1000);
    setInterval(() => tick(true), 10 * 60000);
  }

  boot();
})();
