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

  async function homey(path, retried, opts) {
    const s = state.homey;
    try {
      const init = opts ? { method: opts.method, headers: { Authorization: 'Bearer ' + s.session, 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) } : { headers: { Authorization: 'Bearer ' + s.session } };
      const r = await withTimeout((signal) => fetch(s.base + path, { signal, ...init }), 15000);
      if (r.status === 401 && !retried) { await connectHomey(true); return homey(path, true, opts); }
      if (!r.ok) throw new Error('Homey ' + r.status);
      return r.json();
    } catch (e) {
      // Left home: the local address stops working, so switch to the remote one.
      if (!retried && s.remote && s.base !== s.remote) { s.base = s.remote; store.set('homey', s); return homey(path, true, opts); }
      if (!retried && s.local && s.base !== s.local) {
        const back = { ...s, base: s.local };
        try { state.homey = back; const res = await homey(path, true, opts); store.set('homey', back); return res; } catch (e2) { state.homey = s; }
      }
      throw e;
    }
  }

  // ---------- prices ----------
  function gridAt(h) { return (C.tariffs.grid.find((g) => h >= g.from && h < g.to) || { kr: 0 }).kr; }
  // All network tariffs and taxes for an hour, kr/kWh excl. VAT. Real ones from Eloverblik when the
  // token is set (they already include Energinet's tariffs and elafgift), otherwise the sample in config.js.
  function tariffAt(h) {
    const T = C.tariffs;
    if (state.tariffs && state.tariffs.hourly) return { grid: state.tariffs.hourly[h], other: T.supplierMarkup };
    return { grid: gridAt(h), other: T.energinet + T.supplierMarkup + T.elafgift };
  }
  function withAllIn(p) {
    const h = +p.t.slice(11, 13);
    const { grid, other } = tariffAt(h);
    const vat = (p.spot + grid + other) * C.tariffs.vat;
    return { t: p.t, spot: p.spot, grid, other, vat, total: p.spot + grid + other + vat };
  }
  // elprisenligenu.dk first (same day-ahead prices, browser access allowed); Energi Data Service as a
  // fallback, although it currently refuses requests from browsers.
  async function fromEnergiDataService(start, end) {
    const url = 'https://api.energidataservice.dk/dataset/DayAheadPrices?start=' + start + 'T00:00&end=' + end + 'T00:00&filter=' + encodeURIComponent(JSON.stringify({ PriceArea: [C.priceArea] })) + '&sort=TimeDK%20asc&limit=400';
    const r = await withTimeout((signal) => fetch(url, { signal }), 15000);
    if (!r.ok) throw new Error('prices ' + r.status);
    const j = await r.json();
    return (j.records || []).filter((x) => x.DayAheadPriceDKK != null).map((x) => ({ t: x.TimeDK.slice(0, 16), spot: x.DayAheadPriceDKK / 1000 }));
  }
  async function fromElprisenLigeNu(day) {
    const url = 'https://www.elprisenligenu.dk/api/v1/prices/' + day.slice(0, 4) + '/' + day.slice(5, 7) + '-' + day.slice(8, 10) + '_' + C.priceArea + '.json';
    // no-store: a 'not published yet' answer fetched before ~13:00 must not be reused from the phone's cache
    const r = await withTimeout((signal) => fetch(url, { signal, cache: 'no-store' }), 15000);
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
    try {
      raw = await fromElprisenLigeNu(start);
      if (!raw.length) throw new Error('no prices');
      raw = raw.concat(await fromElprisenLigeNu(dayKey(1)).catch(() => []));
    } catch (e) { raw = await fromEnergiDataService(start, end); }
    state.prices = raw.map(withAllIn);
    state.pricesDay = start;
    setS('prices', { day: start, list: state.prices });
  }
  function hourly(day) {
    const out = [];
    for (let h = 0; h < 24; h++) {
      const key = day + 'T' + String(h).padStart(2, '0');
      const q = state.prices.filter((p) => p.t.startsWith(key));
      if (q.length) { out.push({ h, total: q.reduce((a, p) => a + p.total, 0) / q.length }); continue; }
      const f = state.forecast && state.forecast.days[day] && state.forecast.days[day][h];
      out.push(f != null ? { h, total: withAllIn({ t: key + ':00', spot: f }).total, fc: true } : { h, total: null });
    }
    return out;
  }
  // Forecast of the spot price from elpriser.org (their own weather-based model, not official),
  // used only for hours that have no published price yet. Spot in DKK/kWh excl. VAT.
  async function loadForecast() {
    const r = await withTimeout((signal) => fetch('https://elpriser.org/api/forecast?area=' + C.priceArea + '&mode=spot_ex', { signal }), 20000);
    if (!r.ok) throw new Error('forecast ' + r.status);
    const j = await r.json();
    const days = {};
    (j.days || []).forEach((d) => {
      if (d.type === 'actual' || !Array.isArray(d.prices)) return;
      const hrs = new Array(24).fill(null);
      d.prices.forEach((p) => { if (num(+p.price) != null && p.hour >= 0 && p.hour < 24) hrs[p.hour] = +p.price; });
      days[d.date] = hrs;
    });
    state.forecast = { at: Date.now(), days };
    setS('forecast', state.forecast);
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
    return '<article class="' + cls + '" data-id="' + esc(d.id) + '" role="button" tabindex="0">' +
      '<div class="tile-top"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[iconFor(d)] + '</svg>' +
      '<span class="' + (t.on ? '' : 'muted') + '">' + esc(t.sub) + '</span></div>' +
      '<div><div class="tile-name">' + esc(d.name) + '</div>' +
      '<div class="tile-zone muted">' + esc(t.main) + (showZone && zoneName(d.zone) ? ' · ' + esc(zoneName(d.zone)) : '') + '</div></div>' +
      '</article>';
  }

  // ---------- device control ----------
  const canSet = (d, cap) => d.capabilitiesObj && d.capabilitiesObj[cap] && d.capabilitiesObj[cap].setable !== false;
  async function setCap(d, cap, value) {
    if (DEMO) { d.capabilitiesObj[cap].value = value; return; }
    await homey('/api/manager/devices/device/' + d.id + '/capability/' + cap, false, { method: 'PUT', body: { value } });
    d.capabilitiesObj[cap].value = value;
  }
  // Tap: a plain on/off device just toggles; anything else opens a sheet with its controls and readings.
  async function onTile(id) {
    const d = state.devices[id] || deviceList().find((x) => x.id === id);
    if (!d) return;
    const simple = canSet(d, 'onoff') && !canSet(d, 'dim') && !canSet(d, 'windowcoverings_state') && !canSet(d, 'speaker_playing');
    if (simple) {
      const el = document.querySelector('.tile[data-id="' + CSS.escape(id) + '"]');
      if (el) el.classList.add('busy');
      try { await setCap(d, 'onoff', !d.capabilitiesObj.onoff.value); } catch (e) { setStatus('Could not switch ' + d.name + '.'); }
      renderZoneGroups();
      return;
    }
    openDevice(d);
  }
  const CAP_LABEL = { measure_temperature: ['Temperature', '°'], measure_humidity: ['Humidity', ' %'], measure_battery: ['Battery', ' %'], measure_power: ['Power', ' W'], meter_power: ['Energy', ' kWh'], alarm_contact: ['Contact'], alarm_motion: ['Motion'], measure_luminance: ['Light', ' lx'], volume_set: ['Volume'] };
  function openDevice(d) {
    state.devDevice = d.id;
    $('dev-title').textContent = d.name;
    $('dev-zone').textContent = zoneName(d.zone) || '';
    $('dev-error').hidden = true;
    const o = d.capabilitiesObj || {};
    let h = '';
    if (canSet(d, 'windowcoverings_state')) h += '<div class="dev-btns"><button data-act="wc" data-v="up" type="button">Up</button><button data-act="wc" data-v="idle" type="button">Stop</button><button data-act="wc" data-v="down" type="button">Down</button></div>';
    if (canSet(d, 'windowcoverings_set')) h += '<label class="field">Position <input type="range" min="0" max="100" step="5" data-act="wcset" value="' + Math.round((o.windowcoverings_set.value || 0) * 100) + '"></label>';
    if (canSet(d, 'speaker_playing')) h += '<button class="dev-toggle' + (o.speaker_playing.value ? ' on' : '') + '" data-act="play" type="button">' + (o.speaker_playing.value ? 'Pause' : 'Play') + '</button>';
    if (canSet(d, 'volume_set')) { const vol = Math.round((o.volume_set.value || 0) * 100); h += '<div class="field">Volume <span id="vol-val">' + vol + ' %</span><div class="vol-row"><button class="vol-btn" data-act="voldown" type="button" aria-label="Volume down">−</button><input type="range" min="0" max="100" step="2" data-act="vol" value="' + vol + '" aria-label="Volume"><button class="vol-btn" data-act="volup" type="button" aria-label="Volume up">+</button></div></div>'; }
    if (canSet(d, 'onoff')) h += '<button class="dev-toggle' + (o.onoff.value ? ' on' : '') + '" data-act="onoff" type="button">' + (o.onoff.value ? 'On · tap to turn off' : 'Off · tap to turn on') + '</button>';
    if (canSet(d, 'dim')) h += '<label class="field">Brightness <input type="range" min="1" max="100" step="1" data-act="dim" value="' + Math.round((o.dim.value || 0) * 100) + '"></label>';
    const rows = Object.keys(CAP_LABEL).filter((k) => o[k] && o[k].value != null && k !== 'volume_set').map((k) => {
      const [lab, unit] = CAP_LABEL[k]; let v = o[k].value;
      if (k === 'alarm_contact') v = v ? 'Open' : 'Closed'; else if (k === 'alarm_motion') v = v ? 'Motion' : 'Quiet'; else v = (typeof v === 'number' ? (Math.abs(v) < 100 ? f1(v) : Math.round(v)) : v) + (unit || '');
      return '<div class="dev-row"><span class="muted">' + lab + '</span><span>' + esc(String(v)) + '</span></div>';
    });
    const upd = Object.values(o).map((c) => c.lastUpdated).filter(Boolean).sort().slice(-1)[0];
    if (upd) rows.push('<div class="dev-row"><span class="muted">Last update</span><span>' + new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(upd)) + '</span></div>');
    h += rows.length ? '<div>' + rows.join('') + '</div>' : '';
    if (!h) h = '<p class="muted small">Nothing to control or show for this device.</p>';
    $('dev-body').innerHTML = h;
    $('dev-sheet').hidden = false; $('sheet-backdrop').hidden = false;
  }
  function closeDevice() { $('dev-sheet').hidden = true; if ($('sheet').hidden) $('sheet-backdrop').hidden = true; state.devDevice = null; }
  async function devAction(el) {
    const d = state.devices[state.devDevice] || deviceList().find((x) => x.id === state.devDevice);
    if (!d) return;
    const o = d.capabilitiesObj;
    const act = el.dataset.act;
    $('dev-error').hidden = true;
    try {
      if (act === 'wc') await setCap(d, 'windowcoverings_state', el.dataset.v);
      else if (act === 'wcset') await setCap(d, 'windowcoverings_set', +el.value / 100);
      else if (act === 'play') await setCap(d, 'speaker_playing', !o.speaker_playing.value);
      else if (act === 'vol') await setCap(d, 'volume_set', +el.value / 100);
      else if (act === 'volup' || act === 'voldown') {
        const v = Math.min(1, Math.max(0, Math.round(((o.volume_set.value || 0) + (act === 'volup' ? 0.05 : -0.05)) * 100) / 100));
        await setCap(d, 'volume_set', v);
        const r = $('dev-body').querySelector('input[data-act="vol"]'); if (r) r.value = Math.round(v * 100);
      }
      if (['vol', 'volup', 'voldown'].includes(act) && $('vol-val')) $('vol-val').textContent = Math.round((o.volume_set.value || 0) * 100) + ' %';
      else if (act === 'onoff') await setCap(d, 'onoff', !o.onoff.value);
      else if (act === 'dim') await setCap(d, 'dim', +el.value / 100);
      if (['play', 'onoff'].includes(act)) openDevice(d);
      renderZoneGroups();
    } catch (e) { $('dev-error').textContent = 'Homey did not accept that. ' + (e.message || ''); $('dev-error').hidden = false; }
  }

  // ---------- render ----------
  function render() {
    $('now-label').textContent = nowLabel();
    renderPrices();
    renderHouse();
    renderHeat();
    if (state.tab === 'devices') renderZoneGroups();
    if (state.tab === 'energy') renderEnergy();
    if (state.tab === 'history') renderHistory();
  }

  function renderPrices() {
    const today = dayKey(0), tomorrow = dayKey(1);
    const hrs = hourly(today);
    const h = nowHour();
    // rolling 24 hours: this hour and the next 23 (tomorrow's are published around 13:00)
    const win = hrs.slice(h).map((x) => ({ ...x, day: 0 })).concat(hourly(tomorrow).slice(0, h).map((x) => ({ ...x, day: 1 })));
    const lvl = levelFn(win);
    const now = state.prices.find((p) => p.t === nowKey());
    // tariff info lives in Settings and on the Energy tab; the front tile stays clean
    $('tariff-note').hidden = true;
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
    const max = Math.max(1, ...win.map((x) => x.total || 0));
    $('bars').innerHTML = win.map((x, i) => {
      const ht = x.total == null ? 4 : Math.max(4, Math.round((x.total / max) * 72));
      const cls = 'bar ' + (x.total == null ? 'pending' : lvl(x.total)) + (x.fc ? ' fc' : '') + (i === 0 ? ' now' : '') + (x.day === 1 && x.h === 0 ? ' midnight' : '');
      return '<div class="' + cls + '" style="height:' + ht + 'px"' + (x.day === 1 && x.h === 0 ? ' data-label="' + new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TZ }).format(new Date(tomorrow + 'T12:00:00')) + '"' : '') + '></div>';
    }).join('');
    $('bars').setAttribute('aria-label', 'All-in price for the next 24 hours');
    $('bar-axis').innerHTML = [0, 6, 12, 18, 23].map((i) => {
      const x = win[i];
      return '<span>' + (i === 0 ? 'Now' : String(x.h).padStart(2, '0')) + '</span>';
    }).join('');
    const firstTomorrow = win.findIndex((x) => x.day === 1);
    const rest = firstTomorrow < 0 ? [] : win.slice(firstTomorrow);
    $('bars-note').textContent = rest.some((x) => x.fc) ? 'Pale bars are a forecast. Real prices arrive around 13:00.' : rest.some((x) => x.total == null) ? 'Tomorrow’s prices arrive around 13:00' : '';
    // cheapest next hour, from the next hour on, today and tomorrow
    const ahead = hrs.filter((x) => x.h > h && x.total != null).map((x) => ({ ...x, day: 'today' }))
      .concat(hourly(tomorrow).filter((x) => x.total != null).map((x) => ({ ...x, day: 'tomorrow' })));
    if (ahead.length) {
      const best = ahead.reduce((a, b) => (b.total < a.total ? b : a));
      $('next-cheap-text').innerHTML = 'Cheapest next at <b>' + String(best.h).padStart(2, '0') + ':00</b>' + (best.day === 'tomorrow' ? ' tomorrow' : '') + (best.fc ? ' (forecast)' : '');
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
      $('house-power-note').textContent = 'Appears when the energy meters are installed';
    }
    renderYesterday();
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
    if (now) {
      const h = +now.t.slice(11, 13);
      const rows = state.tariffs
        ? [['Spot price, ' + C.priceArea, now.spot]].concat(state.tariffs.parts.filter((p) => p.per[h]).map((p) => [p.name, p.per[h]]), [['Supplier markup (estimate)', T.supplierMarkup], ['VAT 25 %', now.vat]])
        : [['Spot price, ' + C.priceArea, now.spot], ['Grid tariff (sample)', now.grid], ['Energinet (sample)', T.energinet], ['Supplier markup (estimate)', T.supplierMarkup], ['Elafgift', T.elafgift], ['VAT 25 %', now.vat]];
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
      $(el).innerHTML = (hrs.some((x) => x.fc) ? '<p class="muted small">Forecast from elpriser.org until the real prices are published around 13:00.</p>' : '') + hrs.map((x) => '<div class="hour-row' + (x.fc ? ' fc' : '') + (isToday && x.h === h ? ' now' : '') + (isToday && x.h < h ? ' past' : '') + '"><span>' + String(x.h).padStart(2, '0') + ':00</span><span class="track"><span class="fill ' + lvl(x.total) + '" style="display:block;width:' + Math.round((x.total / max) * 100) + '%"></span></span><span class="price">' + f2(x.total) + '</span></div>').join('');
    };
    list(dayKey(0), 'list-today', true);
    list(dayKey(1), 'list-tomorrow', false);
  }

  // ---------- Eloverblik: real tariffs and yesterday's consumption ----------
  const ELO = 'https://api.eloverblik.dk/customerapi/api';
  function keyDK(ms) { const p = partsDK(new Date(ms)); return `${p.year}-${p.month}-${p.day}T${p.hour}:${String(Math.floor(+p.minute / 15) * 15).padStart(2, '0')}`; }

  async function eloToken() {
    const c = store.get('eloAccess');
    if (c && c.token && Date.now() < c.exp) return c.token;
    const refresh = store.get('eloRefresh');
    if (!refresh) throw new Error('no token');
    const r = await withTimeout((signal) => fetch(ELO + '/token', { signal, headers: { Authorization: 'Bearer ' + refresh } }), 30000);
    if (r.status === 401) throw new Error('the token was refused, create a new one');
    if (!r.ok) throw new Error('error ' + r.status);
    const j = await r.json();
    store.set('eloAccess', { token: j.result, exp: Date.now() + 20 * 3600000 });
    return j.result;
  }
  async function elo(path, body) {
    const t = await eloToken();
    const r = await withTimeout((signal) => fetch(ELO + path, { signal, method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), 45000);
    if (r.status === 401) { store.del('eloAccess'); throw new Error('access expired, try again'); }
    if (!r.ok) throw new Error('error ' + r.status);
    return r.json();
  }
  async function eloMeter() {
    const saved = store.get('eloMeter');
    if (saved) return saved;
    const j = await elo('/meteringpoints/meteringpoints?includeAll=false');
    const list = j.result || [];
    const m = list.find((x) => x.typeOfMP === 'E17') || list[0];
    if (!m) throw new Error('no meter found');
    const meter = { id: m.meteringPointId };
    store.set('eloMeter', meter);
    return meter;
  }
  async function loadTariffs() {
    const meter = await eloMeter();
    const j = await elo('/meteringpoints/meteringpoint/getcharges', { meteringPoints: { meteringPoint: [meter.id] } });
    const res = (j.result && j.result[0] && j.result[0].result) || {};
    const hourly = new Array(24).fill(0);
    const parts = (res.tariffs || []).map((t) => {
      const prices = (t.prices || []).map((p) => ({ pos: +p.position, kr: +p.price })).filter((p) => num(p.kr) != null);
      const per = new Array(24).fill(0);
      if (prices.length === 1) per.fill(prices[0].kr);
      else if (prices.length > 1) {
        // 24 hourly or 96 quarter-hour positions: average them per hour
        const sums = new Array(24).fill(0), cnt = new Array(24).fill(0);
        prices.forEach((p) => { const h = Math.min(23, Math.max(0, Math.floor(((p.pos - 1) * 24) / prices.length))); sums[h] += p.kr; cnt[h]++; });
        for (let h = 0; h < 24; h++) per[h] = cnt[h] ? sums[h] / cnt[h] : 0;
      }
      per.forEach((v, h) => { hourly[h] += v; });
      return { name: t.name || t.description || 'Tariff', per };
    });
    if (!parts.length) throw new Error('no tariffs returned');
    state.tariffs = { at: Date.now(), hourly, parts };
    store.set('tariffs', state.tariffs);
    state.prices = state.prices.map(withAllIn);
  }
  async function loadYesterday() {
    const meter = await eloMeter();
    for (const back of [1, 2, 3, 4, 5, 6, 7]) {
      const day = dayKey(-back), next = dayKey(-back + 1);
      const j = await elo('/meterdata/gettimeseries/' + day + '/' + next + '/Hour', { meteringPoints: { meteringPoint: [meter.id] } });
      const doc = j.result && j.result[0] && j.result[0].MyEnergyData_MarketDocument;
      const pts = [];
      ((doc && doc.TimeSeries) || []).forEach((ts) => (ts.Period || []).forEach((per) => {
        const start = new Date(per.timeInterval.start).getTime();
        const mins = per.resolution === 'PT15M' ? 15 : 60;
        (per.Point || []).forEach((pt) => { const q = +pt['out_Quantity.quantity']; if (num(q) != null) pts.push({ t: start + (+pt.position - 1) * mins * 60000, mins, kwh: q }); });
      }));
      // Eloverblik sometimes publishes only part of a day: use a day only when all hours are in
      const hrs = new Set(pts.map((p) => keyDK(p.t).slice(0, 13))).size;
      if (hrs < 23) continue; // not (fully) published yet: try the day before
      const prices = new Map((await fromElprisenLigeNu(day)).map((p) => [p.t, withAllIn(p).total]));
      let kwh = 0, cost = 0;
      for (const p of pts) {
        kwh += p.kwh;
        const qs = [];
        for (let m = 0; m < p.mins; m += 15) { const pr = prices.get(keyDK(p.t + m * 60000)); if (pr != null) qs.push(pr); }
        if (qs.length) cost += p.kwh * (qs.reduce((a, b) => a + b, 0) / qs.length);
      }
      state.yesterday = { day, back, kwh, cost, avg: kwh ? cost / kwh : null, priced: prices.size > 0, at: Date.now() };
      store.set('yesterday', state.yesterday);
      return;
    }
    // nothing new published: keep the last good day rather than showing a dash
    const prev = state.yesterday;
    state.yesterday = prev && prev.kwh != null ? Object.assign({}, prev, { at: Date.now() }) : { none: true, at: Date.now() };
  }
  async function loadEloverblik(force) {
    if (DEMO || !store.get('eloRefresh')) { render(); return; }
    state.eloError = null;
    try {
      const t = state.tariffs;
      if (force || !t || Date.now() - t.at > 24 * 3600000) await loadTariffs();
      const y = state.yesterday;
      if (force || !y || (y.day !== dayKey(-1) && !(y.at && Date.now() - y.at < 2 * 3600000))) await loadYesterday();
      await loadHistory(force);
    } catch (e) { state.eloError = 'Eloverblik: ' + e.message; }
    render();
  }

  function renderYesterday() {
    const y = state.yesterday;
    $('yday-label').textContent = 'Yesterday';
    if (!DEMO && !store.get('eloRefresh')) { $('yday-cost').textContent = '—'; $('yday-note').textContent = 'Add your Eloverblik token in Settings'; return; }
    if (state.eloError && !(y && y.kwh != null)) { $('yday-cost').textContent = '—'; $('yday-note').textContent = state.eloError; return; }
    if (!y) { $('yday-cost').textContent = '—'; $('yday-note').textContent = 'Loading from Eloverblik…'; return; }
    if (y.none) { $('yday-cost').textContent = '—'; $('yday-note').textContent = 'Not published by Eloverblik yet'; return; }
    if (/^\d{4}-/.test(y.day || '') && y.day !== dayKey(-1)) $('yday-label').textContent = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: TZ }).format(new Date(y.day + 'T12:00:00'));
    $('yday-cost').textContent = y.priced ? Math.round(y.cost) : '—';
    $('yday-note').textContent = f1(y.kwh) + ' kWh' + (y.priced ? ' · ' + f2(y.avg) + ' kr/kWh' : '');
  }

  // ---------- History: consumption from Eloverblik ----------
  function parseSeries(j) {
    const doc = j.result && j.result[0] && j.result[0].MyEnergyData_MarketDocument;
    const pts = [];
    ((doc && doc.TimeSeries) || []).forEach((ts) => (ts.Period || []).forEach((per) => {
      const start = new Date(per.timeInterval.start).getTime();
      const step = per.resolution === 'PT15M' ? 15 * 60000 : per.resolution === 'PT1H' ? 3600000 : 0;
      (per.Point || []).forEach((pt) => { const q = +pt['out_Quantity.quantity']; if (num(q) != null) pts.push({ t: start + (+pt.position - 1) * step, step, kwh: q }); });
    }));
    return pts;
  }
  async function loadHistory(force) {
    if (DEMO || !store.get('eloRefresh')) return;
    const h = store.get('history') || { days: {}, months: {} };
    if (!force && h.at && Date.now() - h.at < 6 * 3600000) { state.history = h; return; }
    const meter = await eloMeter();
    const body = { meteringPoints: { meteringPoint: [meter.id] } };
    // last 31 days by the hour, priced with each day's spot prices and your tariffs
    const hours = parseSeries(await elo('/meterdata/gettimeseries/' + dayKey(-31) + '/' + dayKey(0) + '/Hour', body));
    const byDay = {};
    hours.forEach((p) => { const k = keyDK(p.t).slice(0, 10); (byDay[k] = byDay[k] || []).push(p); });
    for (const [day, pts] of Object.entries(byDay)) {
      const kwh = pts.reduce((a, p) => a + p.kwh, 0);
      const old = h.days[day];
      if (old && old.cost != null && Math.abs(old.kwh - kwh) < 0.01) continue;
      let cost = null;
      try {
        const prices = new Map((await fromElprisenLigeNu(day)).map((p) => [p.t, withAllIn(p).total]));
        if (prices.size) {
          cost = 0;
          for (const p of pts) {
            const qs = []; for (let m = 0; m < (p.step || 3600000); m += 15 * 60000) { const pr = prices.get(keyDK(p.t + m)); if (pr != null) qs.push(pr); }
            if (qs.length) cost += p.kwh * (qs.reduce((a, b) => a + b, 0) / qs.length);
          }
        }
      } catch (e) { /* price for that day not available: kWh only */ }
      h.days[day] = { kwh, cost };
    }
    // 24 months, summed per calendar month
    const first = new Date(); first.setMonth(first.getMonth() - 23, 1);
    const fromM = first.getFullYear() + '-' + String(first.getMonth() + 1).padStart(2, '0') + '-01';
    const days = parseSeries(await elo('/meterdata/gettimeseries/' + fromM + '/' + dayKey(0) + '/Day', body));
    const months = {};
    days.forEach((p) => { const k = keyDK(p.t + 12 * 3600000).slice(0, 7); months[k] = (months[k] || 0) + p.kwh; });
    h.months = months;
    Object.keys(h.days).filter((d) => d < dayKey(-40)).forEach((d) => delete h.days[d]);
    h.at = Date.now();
    store.set('history', h);
    state.history = h;
  }

  function barChart(el, items, opts) {
    const W = Math.max(240, el.clientWidth), H = 150, l = 30, r = 4, top = 8, bottom = 22;
    if (!items.length) { el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">' + (opts.empty || 'No data yet') + '</text></svg>'; return; }
    const max = Math.max(1, ...items.map((x) => x.v)) * 1.08;
    const step = max <= 20 ? 5 : max <= 60 ? 10 : max <= 300 ? 50 : max <= 1200 ? 200 : 500;
    const y = (v) => top + (1 - v / max) * (H - top - bottom);
    const bw = (W - l - r) / items.length;
    let g = '';
    for (let v = 0; v <= max; v += step) g += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)"' + (v ? ' stroke-dasharray="2 3"' : '') + '></line><text x="' + (l - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    const bars = items.map((x, i) => '<rect x="' + (l + i * bw + bw * 0.15).toFixed(1) + '" y="' + y(x.v).toFixed(1) + '" width="' + (bw * 0.7).toFixed(1) + '" height="' + Math.max(0, y(0) - y(x.v)).toFixed(1) + '" rx="2" fill="' + (x.color || 'var(--ground)') + '"' + (x.faint ? ' opacity="0.45"' : '') + '><title>' + x.title + '</title></rect>').join('');
    const labs = items.map((x, i) => (x.label ? '<text x="' + (i === items.length - 1 && opts.endLabel ? W - r : l + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === items.length - 1 && opts.endLabel ? 'end' : 'middle') + '">' + x.label + '</text>' : '')).join('');
    const avg = opts.avg != null ? '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(opts.avg).toFixed(1) + '" y2="' + y(opts.avg).toFixed(1) + '" stroke="var(--ink)" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.6"></line>' : '';
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + g + bars + avg + labs + '</svg>';
  }

  function renderHistory() {
    const sub = state.histTab || 'el';
    document.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.hist === sub)));
    $('hist-el').hidden = sub !== 'el'; $('hist-heat').hidden = sub !== 'heat';
    if (sub === 'heat') { renderHeatHistory(); if (!DEMO && (!state.heatHist || Date.now() - state.heatHist.at > 30 * 60000)) loadHeatHistory().then(renderHeatHistory).catch(() => { $('hh-status').hidden = false; $('hh-status').textContent = 'Could not load room history from Homey.'; }); return; }
    const h = state.history;
    if (!h) {
      const msg = DEMO ? 'Loading…' : store.get('eloRefresh') ? 'Loading from Eloverblik…' : 'Add your Eloverblik token in Settings';
      ['h30-kwh', 'h30-kr', 'h30-avg'].forEach((id) => { $(id).textContent = '—'; });
      $('h30-note').textContent = msg; $('hm-summary').innerHTML = '';
      barChart($('h30-chart'), [], { empty: msg }); barChart($('hm-chart'), [], { empty: msg });
      return;
    }
    const keys = Object.keys(h.days).sort().slice(-30);
    const ds = keys.map((k) => ({ k, ...h.days[k] }));
    const kwh = ds.reduce((a, d) => a + d.kwh, 0);
    const priced = ds.filter((d) => d.cost != null);
    const cost = priced.reduce((a, d) => a + d.cost, 0);
    $('h30-kwh').textContent = ds.length ? Math.round(kwh) + ' kWh' : '—';
    $('h30-kr').textContent = priced.length ? Math.round(cost).toLocaleString('da-DK') + ' kr' : '—';
    $('h30-avg').textContent = ds.length ? f1(kwh / ds.length) + ' kWh' : '—';
    const wd = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: TZ });
    const dm = (k) => +k.slice(8, 10) + '/' + +k.slice(5, 7);
    barChart($('h30-chart'), ds.map((d, i) => {
      const date = new Date(d.k + 'T12:00:00');
      const weekend = [0, 6].includes(date.getDay());
      return { v: d.kwh, color: weekend ? 'var(--first)' : 'var(--ground)', label: (ds.length - 1 - i) % 7 === 0 ? dm(d.k) : '', title: wd.format(date) + ' ' + dm(d.k) + ': ' + f1(d.kwh) + ' kWh' + (d.cost != null ? ', ' + Math.round(d.cost) + ' kr' : '') };
    }), { avg: ds.length ? kwh / ds.length : null, endLabel: true });
    const last = ds[ds.length - 1];
    $('h30-note').textContent = ds.length ? 'Orange bars are weekends; the dashed line is the average. Latest day: ' + dm(last.k) + ' (Eloverblik is 1–2 days behind).' : 'No consumption data yet.';

    const mk = Object.keys(h.months).sort().slice(-24);
    const thisM = dayKey(0).slice(0, 7);
    const mon = new Intl.DateTimeFormat('en-GB', { month: 'narrow', timeZone: 'UTC' });
    barChart($('hm-chart'), mk.map((k) => ({ v: h.months[k], faint: k === thisM, color: 'var(--ground)', label: mon.format(new Date(k + '-15T12:00:00Z')), title: new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(k + '-15T12:00:00Z')) + ': ' + Math.round(h.months[k]) + ' kWh' })), {});
    const sum = [];
    const yr = (y) => mk.filter((k) => k.startsWith(y)).reduce((a, k) => a + h.months[k], 0);
    const lastFull = mk.filter((k) => k < thisM).slice(-1)[0];
    if (lastFull) {
      const ly = (+lastFull.slice(0, 4) - 1) + lastFull.slice(4);
      const name = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(lastFull + '-15T12:00:00Z'));
      let t = name + ': <b>' + Math.round(h.months[lastFull]) + ' kWh</b>';
      if (h.months[ly]) { const d = (h.months[lastFull] / h.months[ly] - 1) * 100; t += ' · ' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(0) + ' % vs last year'; }
      sum.push(t);
    }
    const y12 = mk.filter((k) => k < thisM).slice(-12);
    if (y12.length === 12) sum.push('Last 12 months: <b>' + Math.round(y12.reduce((a, k) => a + h.months[k], 0)).toLocaleString('da-DK') + ' kWh</b>');
    if (h.months[thisM]) sum.push('This month so far: ' + Math.round(h.months[thisM]) + ' kWh (pale bar)');
    $('hm-summary').innerHTML = sum.map((p) => '<li><span>' + p + '</span></li>').join('');
  }

  // ---------- How the house holds heat ----------
  state.heat = { outside: null, hist: {}, source: null };
  const DAY = 24 * 3600000;

  const HEAT = (C.heat || []).length ? C.heat : [{ key: 'ground', label: 'Ground floor', zones: [] }];
  const heatSpec = (key) => HEAT.find((x) => x.key === key) || { zones: [] };
  function floorDevices(key) {
    const spec = heatSpec(key);
    const zones = (spec.zones || []).map((n) => n.trim().toLowerCase());
    const names = (spec.devices || []).map((n) => n.trim().toLowerCase());
    return Object.values(state.devices).filter((d) => d.capabilitiesObj && d.capabilitiesObj.measure_temperature &&
      (zones.includes(zoneName(d.zone).trim().toLowerCase()) || names.includes(String(d.name).trim().toLowerCase())));
  }
  function floorNow(key) {
    const v = floorDevices(key).map((d) => d.capabilitiesObj.measure_temperature.value).filter((x) => num(x) != null);
    if (v.length) return v.reduce((a, b) => a + b, 0) / v.length;
    const h = DEMO && state.heat.hist[key];
    return h && h.length ? h[h.length - 1].v : null;
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

  // Homey Insights: entries live at /log/<owner uri>/<log id>/entry (second form kept as a fallback).
  async function insightSeries(deviceId, cap, resolution) {
    const full = 'homey:device:' + deviceId + ':' + (cap || 'measure_temperature');
    const res = resolution || 'last24Hours';
    const paths = [
      '/api/manager/insights/log/' + encodeURIComponent('homey:device:' + deviceId) + '/' + encodeURIComponent(full) + '/entry?resolution=' + res,
      '/api/manager/insights/log/' + encodeURIComponent(full) + '/entry?resolution=' + res,
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
    const log = getS('heatlog') || {};
    const now = Date.now();
    HEAT.forEach(({ key: k }) => {
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
    for (const { key: k } of HEAT) {
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

  // ---------- History: heating ----------
  const ROOM_COLOR = { ground: 'var(--ground)', south: 'var(--first)', north: 'var(--north)' };
  const hourKey = (t) => keyDK(t).slice(0, 13);
  // average a series into one value per local hour: { 'YYYY-MM-DDTHH': value }
  function hourly1(series) {
    const sum = {}, cnt = {};
    (series || []).forEach((p) => { const k = hourKey(p.t); sum[k] = (sum[k] || 0) + p.v; cnt[k] = (cnt[k] || 0) + 1; });
    const out = {}; Object.keys(sum).forEach((k) => { out[k] = sum[k] / cnt[k]; });
    // sensors only report on change, so carry the last value into empty hours (up to 6 h)
    const ts = (series || []).map((p) => p.t);
    if (ts.length) {
      let last = null, age = 0;
      for (let t = Math.floor(Math.min(...ts) / 3600000) * 3600000; t <= Math.min(Date.now(), Math.max(...ts) + 6 * 3600000); t += 3600000) {
        const k = hourKey(t);
        if (out[k] != null) { last = out[k]; age = 0; } else if (last != null && ++age <= 6) out[k] = last;
      }
    }
    return out;
  }
  async function loadHeatHistory(force) {
    if (DEMO) return;
    const hh = state.heatHist;
    if (!force && hh && Date.now() - hh.at < 30 * 60000) return;
    if (!state.homey) return;
    // Homey keeps hourly values for 14 days (last31Days is 6-hourly), so fetch 14 days
    // hourly and keep a rolling 60-day copy on this device to build up a longer history.
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('home.heatHist') || '{}') || {}; } catch (e) { saved = {}; }
    const cut = keyDK(Date.now() - 60 * 86400000).slice(0, 13);
    const merge = (a, b) => { const o = Object.assign({}, a || {}, b || {}); Object.keys(o).forEach((k) => { if (k < cut || num(o[k]) == null) delete o[k]; }); return o; };
    const rooms = {};
    for (const { key } of HEAT) {
      const devs = floorDevices(key);
      if (!devs.length) continue;
      const t = await insightSeries(devs[0].id, 'measure_temperature', 'last14Days');
      const h = devs[0].capabilitiesObj.measure_humidity ? await insightSeries(devs[0].id, 'measure_humidity', 'last14Days') : null;
      const old = saved[key] || {};
      rooms[key] = { t: merge(old.t, hourly1(t)), h: merge(old.h, hourly1(h)) };
    }
    try { localStorage.setItem('home.heatHist', JSON.stringify(rooms)); } catch (e) { /* storage full or blocked */ }
    let out = {};
    try {
      const L = C.location || { lat: 56.14, lon: 8.97 };
      const r = await withTimeout((signal) => fetch('https://api.open-meteo.com/v1/forecast?latitude=' + L.lat + '&longitude=' + L.lon + '&hourly=temperature_2m&past_days=31&forecast_days=1&timezone=UTC', { signal }), 20000);
      const j = await r.json();
      out = hourly1(j.hourly.time.map((t, i) => ({ t: new Date(t + 'Z').getTime(), v: j.hourly.temperature_2m[i] })).filter((p) => p.t <= Date.now() && num(p.v) != null));
    } catch (e) { /* without outside */ }
    state.heatHist = { at: Date.now(), rooms, out };
  }
  function heatDays(hh) {
    const keys = new Set();
    Object.values(hh.rooms).forEach((r) => Object.keys(r.t).forEach((k) => keys.add(k.slice(0, 10))));
    return [...keys].sort().filter((d) => d >= dayKey(-30));
  }
  const avgOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  function hoursOf(day) { return Array.from({ length: 24 }, (_, h) => day + 'T' + String(h).padStart(2, '0')); }

  function lineChart(el, days, series, opts) {
    const W = Math.max(240, el.clientWidth), H = 150, l = 34, r = 6, top = 10, bottom = 22;
    const vals = series.flatMap((s) => s.v.filter((v) => v != null)).concat(opts.zero ? [0] : []);
    if (!days.length || vals.length < 2) { el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">' + (opts.empty || 'Collecting – a few more days needed') + '</text></svg>'; return; }
    let lo = Math.min(...vals), hi = Math.max(...vals); const pad = Math.max(0.2, (hi - lo) * 0.12); lo -= pad; hi += pad;
    const x = (i) => l + (days.length === 1 ? (W - l - r) / 2 : (i / (days.length - 1)) * (W - l - r));
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
    const step = hi - lo <= 2 ? 0.5 : hi - lo <= 5 ? 1 : hi - lo <= 12 ? 2 : 5;
    let g = ''; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)"' + (Math.abs(v) < 1e-9 && opts.zero ? '' : ' stroke-dasharray="2 3"') + '></line><text x="' + (l - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + (+v.toFixed(1)).toString().replace('-', '−') + (opts.unit || '') + '</text>';
    const lines = series.map((s) => { const pts = s.v.map((v, i) => (v == null ? null : x(i).toFixed(1) + ',' + y(v).toFixed(1))).filter(Boolean); return pts.length > 1 ? '<polyline fill="none" stroke="' + s.color + '" stroke-width="2.2" stroke-linejoin="round" points="' + pts.join(' ') + '"></polyline>' : pts.length ? '<circle cx="' + pts[0].split(',')[0] + '" cy="' + pts[0].split(',')[1] + '" r="3" fill="' + s.color + '"></circle>' : ''; }).join('');
    const dm = (k) => +k.slice(8, 10) + '/' + +k.slice(5, 7);
    const labs = days.map((d, i) => ((days.length - 1 - i) % 7 === 0 ? '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === days.length - 1 ? 'end' : i === 0 ? 'start' : 'middle') + '">' + dm(d) + '</text>' : '')).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + g + lines + labs + '</svg>';
  }
  function rangeChart(el, days, rows, color) {
    const W = Math.max(240, el.clientWidth), H = 150, l = 34, r = 6, top = 10, bottom = 22;
    const vals = rows.flatMap((d) => (d ? [d.lo, d.hi] : []));
    if (vals.length < 2) { el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">Collecting – a few more days needed</text></svg>'; return; }
    let lo = Math.min(...vals) - 0.3, hi = Math.max(...vals) + 0.3;
    const bw = (W - l - r) / days.length;
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (H - top - bottom);
    const step = hi - lo <= 3 ? 0.5 : hi - lo <= 6 ? 1 : 2;
    let g = ''; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"></line><text x="' + (l - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + (+v.toFixed(1)) + '°</text>';
    const dm = (k) => +k.slice(8, 10) + '/' + +k.slice(5, 7);
    const bars = rows.map((d, i) => { if (!d) return ''; const cx = l + i * bw + bw / 2, w = Math.max(3, Math.min(10, bw * 0.55)); return '<rect x="' + (cx - w / 2).toFixed(1) + '" y="' + y(d.hi).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(2, y(d.lo) - y(d.hi)).toFixed(1) + '" rx="' + (w / 2).toFixed(1) + '" fill="' + color + '" opacity="0.35"><title>' + dm(days[i]) + ': ' + f1(d.lo) + '–' + f1(d.hi) + '°, avg ' + f1(d.avg) + '°</title></rect><circle cx="' + cx.toFixed(1) + '" cy="' + y(d.avg).toFixed(1) + '" r="3" fill="' + color + '"></circle>'; }).join('');
    const labs = days.map((d, i) => ((days.length - 1 - i) % 7 === 0 ? '<text x="' + (l + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === days.length - 1 ? 'end' : 'middle') + '">' + dm(d) + '</text>' : '')).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + g + bars + labs + '</svg>';
  }
  function scatterChart(el, pts) {
    const W = Math.max(240, el.clientWidth), H = 150, l = 40, r = 8, top = 10, bottom = 24;
    if (pts.length < 2) { el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">Needs a few more nights</text></svg>'; return; }
    let x0 = Math.min(...pts.map((p) => p.x)) - 1, x1 = Math.max(...pts.map((p) => p.x)) + 1;
    let y0 = Math.min(0, ...pts.map((p) => p.y)) - 0.05, y1 = Math.max(0, ...pts.map((p) => p.y)) + 0.05;
    const X = (v) => l + ((v - x0) / (x1 - x0)) * (W - l - r), Y = (v) => top + (1 - (v - y0) / (y1 - y0)) * (H - top - bottom);
    let g = '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="var(--line)"></line>';
    [y0 + 0.05, y1 - 0.05].forEach((v) => { g += '<text x="' + (l - 6) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + v.toFixed(2).replace('-', '−') + '</text>'; });
    for (let v = Math.ceil(x0); v <= x1; v += Math.max(1, Math.round((x1 - x0) / 5))) g += '<text x="' + X(v).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + String(v).replace('-', '−') + '°</text>';
    // least-squares line
    const n = pts.length, mx = avgOf(pts.map((p) => p.x)), my = avgOf(pts.map((p) => p.y));
    const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
    let fit = '';
    if (n >= 4 && sxx > 0.5) { const b = sxy / sxx, a0 = my - b * mx; fit = '<line x1="' + X(x0).toFixed(1) + '" y1="' + Y(a0 + b * x0).toFixed(1) + '" x2="' + X(x1).toFixed(1) + '" y2="' + Y(a0 + b * x1).toFixed(1) + '" stroke="var(--ink)" stroke-dasharray="5 4" opacity="0.5"></line>'; }
    const dots = pts.map((p) => '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="4" fill="var(--ground)" opacity="0.8"><title>' + p.label + ': outside ' + f1(p.x) + '°, ' + (p.y >= 0 ? '+' : '−') + Math.abs(p.y).toFixed(2) + ' °C/h</title></circle>').join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + g + fit + dots + '<text x="' + (W - r) + '" y="' + (top + 10) + '" text-anchor="end">°C per hour</text></svg>';
  }
  function groupedBars(el, days, groups) {
    const W = Math.max(240, el.clientWidth), H = 150, l = 30, r = 4, top = 8, bottom = 22;
    const vals = groups.flatMap((g) => g.v.filter((v) => v != null));
    if (!days.length || !vals.length) { el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '"><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">Collecting</text></svg>'; return; }
    const max = Math.max(4, ...vals);
    const y = (v) => top + (1 - v / max) * (H - top - bottom);
    const bw = (W - l - r) / days.length, sw = (bw * 0.8) / groups.length;
    let g = ''; const step = max <= 8 ? 2 : max <= 16 ? 4 : 6;
    for (let v = 0; v <= max; v += step) g += '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)"' + (v ? ' stroke-dasharray="2 3"' : '') + '></line><text x="' + (l - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + v + 'h</text>';
    const dm = (k) => +k.slice(8, 10) + '/' + +k.slice(5, 7);
    const bars = days.map((d, i) => groups.map((gr, j) => { const v = gr.v[i]; return v ? '<rect x="' + (l + i * bw + bw * 0.1 + j * sw).toFixed(1) + '" y="' + y(v).toFixed(1) + '" width="' + Math.max(1, sw - 0.5).toFixed(1) + '" height="' + (y(0) - y(v)).toFixed(1) + '" fill="' + gr.color + '"><title>' + dm(d) + ' ' + gr.name + ': ' + v + ' h</title></rect>' : ''; }).join('')).join('');
    const labs = days.map((d, i) => ((days.length - 1 - i) % 7 === 0 ? '<text x="' + (l + i * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === days.length - 1 ? 'end' : 'middle') + '">' + dm(d) + '</text>' : '')).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' + g + bars + labs + '</svg>';
  }

  function renderHeatHistory() {
    const hh = state.heatHist;
    if (!hh || !Object.keys(hh.rooms).length) {
      $('hh-status').hidden = false; $('hh-status').textContent = DEMO ? 'Loading…' : state.homey ? 'Loading room history from Homey…' : 'Sign in to Homey to see room history.';
      return;
    }
    const days = heatDays(hh);
    $('hh-status').hidden = days.length >= 7;
    $('hh-status').textContent = days.length + ' day' + (days.length === 1 ? '' : 's') + ' of room history so far. The charts fill in as the days go by.';
    const R = hh.rooms, has = (k) => R[k] && Object.keys(R[k].t).length;
    const dayVals = (k, d) => hoursOf(d).map((h) => R[k] && R[k].t[h]).filter((v) => num(v) != null);

    // 1. room differences
    const gapNS = days.map((d) => { const v = hoursOf(d).map((h) => (R.north && R.south && R.north.t[h] != null && R.south.t[h] != null ? R.north.t[h] - R.south.t[h] : null)).filter((x) => x != null); return v.length >= 6 ? avgOf(v) : null; });
    const gapUD = days.map((d) => { const v = hoursOf(d).map((h) => { const up = ['south', 'north'].map((k) => R[k] && R[k].t[h]).filter((x) => num(x) != null); return up.length && R.ground && R.ground.t[h] != null ? avgOf(up) - R.ground.t[h] : null; }).filter((x) => x != null); return v.length >= 6 ? avgOf(v) : null; });
    lineChart($('hh-gap'), days, [{ v: gapNS, color: 'var(--north)' }, { v: gapUD, color: 'var(--ground)' }], { zero: true, unit: '°' });

    // 2. daily low-high per room
    const keys = HEAT.map((x) => x.key).filter(has);
    if (!state.hhRoom || !keys.includes(state.hhRoom)) state.hhRoom = keys[0];
    $('hh-room-chips').innerHTML = keys.map((k) => '<button class="chip" type="button" data-room="' + k + '" aria-pressed="' + (k === state.hhRoom) + '">' + esc((HEAT.find((x) => x.key === k) || {}).short || k) + '</button>').join('');
    rangeChart($('hh-range'), days, days.map((d) => { const v = dayVals(state.hhRoom, d); return v.length >= 4 ? { lo: Math.min(...v), hi: Math.max(...v), avg: avgOf(v) } : null; }), ROOM_COLOR[state.hhRoom] || 'var(--ground)');

    // 3. sun gain
    const sun = days.map((d) => { const v = hoursOf(d).slice(10, 16).map((h) => (R.south && R.north && R.south.t[h] != null && R.north.t[h] != null ? R.south.t[h] - R.north.t[h] : null)).filter((x) => x != null); return v.length >= 3 ? Math.max(0, Math.max(...v)) : null; });
    barChart($('hh-sun'), days.map((d, i) => ({ v: sun[i] || 0, color: 'var(--first)', label: (days.length - 1 - i) % 7 === 0 ? +d.slice(8, 10) + '/' + +d.slice(5, 7) : '', title: d + ': ' + (sun[i] == null ? 'no data' : '+' + f1(sun[i]) + '°') })), { endLabel: true, empty: 'Collecting' });

    // 4. night cooling vs outside: house average 00 → 05, per night
    const nights = [];
    days.forEach((d) => {
      const hs = hoursOf(d).slice(0, 6);
      const house = hs.map((h) => { const v = keys.map((k) => R[k].t[h]).filter((x) => num(x) != null); return v.length === keys.length ? avgOf(v) : null; });
      const outs = hs.map((h) => hh.out[h]).filter((x) => num(x) != null);
      if (house[0] != null && house[5] != null && outs.length >= 4) nights.push({ x: avgOf(outs), y: (house[5] - house[0]) / 5, label: +d.slice(8, 10) + '/' + +d.slice(5, 7) });
    });
    scatterChart($('hh-night'), nights);
    $('hh-night-note').textContent = nights.length >= 4 ? 'Each dot is a night. Below zero = the house cooled. A steeper dashed line means the house loses heat faster on cold nights. The floor heating is running too, so this is net drift, not pure heat loss.' : 'Each dot will be one night (' + nights.length + ' so far).';

    // 5. humidity hours above 60 %
    const humKeys = keys.filter((k) => Object.keys(R[k].h || {}).length);
    groupedBars($('hh-hum'), days, humKeys.map((k) => ({ name: (HEAT.find((x) => x.key === k) || {}).short || k, color: ROOM_COLOR[k], v: days.map((d) => { const v = hoursOf(d).map((h) => R[k].h[h]).filter((x) => num(x) != null); return v.length ? v.filter((x) => x > 60).length : null; }) })));
    const dry = humKeys.map((k) => { const v = Object.entries(R[k].h).filter(([h]) => h.slice(0, 10) >= dayKey(-7)).map(([, x]) => x); return v.length ? [(HEAT.find((x) => x.key === k) || {}).short || k, v.filter((x) => x < 30).length, avgOf(v)] : null; }).filter(Boolean);
    $('hh-hum-note').textContent = dry.length ? 'Last 7 days: ' + dry.map(([n, c, a]) => n + ' avg ' + Math.round(a) + ' %' + (c ? ' (' + c + ' h below 30 %)' : '')).join(' · ') : '';

    // 6. comfort share 20-23 °C, last 7 days
    $('hh-comfort').innerHTML = keys.map((k) => {
      const v = Object.entries(R[k].t).filter(([h]) => h.slice(0, 10) >= dayKey(-7)).map(([, x]) => x);
      const pct = v.length ? Math.round((v.filter((x) => x >= 20 && x <= 23).length / v.length) * 100) : null;
      return '<div class="comfort-row"><span>' + esc((HEAT.find((x) => x.key === k) || {}).short || k) + '</span><span class="track"><span class="fill" style="width:' + (pct || 0) + '%;background:' + ROOM_COLOR[k] + '"></span></span><span class="pct">' + (pct == null ? '—' : pct + ' %') + '</span></div>';
    }).join('') || '<p class="muted small">No room sensors found.</p>';
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

  // How much warmer the south room is than the north room: now, in daylight (sun) and at night.
  function southNorth(ss, sn) {
    if (!ss.length || !sn.length) return null;
    const pairs = ss.map((p) => { let best = null; for (const q of sn) if (Math.abs(q.t - p.t) <= 40 * 60000 && (!best || Math.abs(q.t - p.t) < Math.abs(best.t - p.t))) best = q; return best ? { t: p.t, d: p.v - best.v } : null; }).filter(Boolean);
    if (pairs.length < 6) return null;
    const hourOf = (t) => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    const day = pairs.filter((p) => { const h = hourOf(p.t); return h >= 10 && h < 16; });
    const night = pairs.filter((p) => { const h = hourOf(p.t); return h >= 0 && h < 6; });
    const avg = (a) => (a.length ? a.reduce((x, p) => x + p.d, 0) / a.length : null);
    return { day: day.length ? Math.max(...day.map((p) => p.d)) : null, night: avg(night) };
  }

  function renderHeat() {
    if (!$('heat-card')) return;
    if (!DEMO) logLocal();
    const now = {}, ser = {}, chg = {};
    HEAT.forEach(({ key }) => { now[key] = floorNow(key); ser[key] = seriesFor(key); chg[key] = change(ser[key], now[key]); });
    const out = state.heat.outside;
    const so = out ? out.series : [];
    const co = out ? change(so, out.now) : null;
    const arrow = (d) => (Math.abs(d) < 0.05 ? '→ 0.0°' : (d > 0 ? '↑ ' : '↓ ') + Math.abs(d).toFixed(1) + '°');
    const dl = (el, d) => { if (!$(el)) return; $(el).textContent = d == null ? 'collecting' : arrow(d); $(el).className = 'heat-delta' + (d != null && d <= -0.8 ? ' delta-bad' : ''); };
    const deg = (v) => f1(v).replace('-', '−') + '°';
    HEAT.forEach(({ key }) => { if ($('heat-' + key)) $('heat-' + key).textContent = now[key] == null ? '—' : deg(now[key]); dl('heat-' + key + '-d', chg[key]); });
    $('heat-out').textContent = out && num(out.now) != null ? deg(out.now) : '—';
    // 24 h low and high with a dot for now
    const colorsR = { ground: 'var(--ground)', south: 'var(--first)', north: 'var(--north)', out: 'var(--out)' };
    const range = (key, list, cur) => {
      const el = $('heat-' + key + '-r'); if (!el) return;
      const vals = (list || []).map((p) => p.v).concat(num(cur) != null ? [cur] : []).filter((v) => num(v) != null);
      if (vals.length < 3) { el.innerHTML = ''; return; }
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const pos = hi - lo < 0.05 ? 50 : ((cur - lo) / (hi - lo)) * 100;
      const short = (v) => v.toFixed(1).replace('-', '−') + '°';
      el.innerHTML = '<span class="track"><span class="fill" style="background:' + colorsR[key] + '"></span>' + (num(cur) != null ? '<span class="now" style="left:' + pos.toFixed(0) + '%;background:' + colorsR[key] + '"></span>' : '') + '</span><span class="lh"><span>' + short(lo) + '</span><span>' + short(hi) + '</span></span>';
      el.title = '24 h low ' + f1(lo) + '°, high ' + f1(hi) + '°';
    };
    HEAT.forEach(({ key }) => range(key, ser[key], now[key]));
    range('out', so, out ? out.now : null);
    $('heat-out-label').textContent = 'Outside';

    const known = HEAT.filter(({ key }) => chg[key] != null);
    const badge = $('heat-badge');
    if (!known.length) { badge.textContent = 'Learning'; badge.className = 'pill'; }
    else {
      const sorted = known.slice().sort((a, b) => chg[a.key] - chg[b.key]);
      const worst = sorted[0];
      const clear = sorted.length < 2 || chg[sorted[1].key] - chg[worst.key] >= 0.3;
      const firstOnly = !clear && sorted.length >= 2 && ['south', 'north'].includes(worst.key) && ['south', 'north'].includes(sorted[1].key) && (sorted.length < 3 || chg[sorted[2].key] - chg[sorted[1].key] >= 0.3);
      if (-chg[worst.key] < 0.6) { badge.textContent = 'Holds well'; badge.className = 'pill good'; }
      else { badge.textContent = clear ? (worst.short || worst.label) + ' cooling' : firstOnly ? '1st floor cooling' : 'Cooling'; badge.className = 'pill warn'; }
    }

    const parts = [];
    const ups = ['south', 'north'].map((k) => now[k]).filter((v) => num(v) != null);
    if (now.ground != null && ups.length) {
      const d = now.ground - ups.reduce((a, b) => a + b, 0) / ups.length;
      parts.push(Math.abs(d) < 0.3 ? 'Both floors about the same' : 'Upstairs <b>' + Math.abs(d).toFixed(1) + '°</b> ' + (d > 0 ? 'cooler' : 'warmer') + ' than downstairs');
    } else if (!HEAT.some(({ key }) => now[key] != null)) {
      parts.push('No room sensors found. Check the rooms in config.js.');
    }
    if (now.south != null && now.north != null) {
      const d = now.south - now.north;
      const sn = southNorth(ser.south, ser.north);
      let t = Math.abs(d) < 0.3 ? 'South and north rooms level now' : (d > 0 ? 'South' : 'North') + ' room <b>' + Math.abs(d).toFixed(1) + '°</b> warmer now';
      if (sn && sn.day != null) t += ' · up to <b>' + signed(sn.day) + '</b> in the sun';
      parts.push(t);
    }
    if (co != null && so.length) {
      const minOut = Math.min(...so.map((p) => p.v));
      parts.push('Outside <b>' + Math.abs(co).toFixed(1) + '°</b> ' + (co < 0 ? 'colder' : 'warmer') + ' than yesterday');
    }
    if (!known.length) parts.push(state.heat.source === 'local' ? 'Building up 24 hours of history; the comparison appears tomorrow' : 'Collecting the last 24 hours…');
    $('heat-summary').innerHTML = parts.map((p) => '<li><span>' + p + '</span></li>').join('');
    drawHeat(ser, so);
  }

  function drawHeat(ser, so) {
    const el = $('heat-chart');
    const W = Math.max(240, el.clientWidth), H = 150, l = 34, r = 6;
    const now = Date.now(), t0 = now - DAY;
    const x = (t) => l + ((t - t0) / DAY) * (W - l - r);
    const fmtT = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
    // one small panel per scale: the rooms share a tight scale, outside gets its own
    const panel = (series, top, h, minSpan, minStep = 1) => {
      const vals = series.flatMap((s) => s.list.map((p) => p.v)).filter((v) => num(v) != null);
      if (!vals.length) return '';
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = Math.max(0.2, (minSpan - (hi - lo)) / 2);
      lo -= pad; hi += pad;
      const y = (v) => top + (1 - (v - lo) / (hi - lo)) * h;
      const step = Math.max(minStep, hi - lo <= 3 ? 1 : hi - lo <= 8 ? 2 : 5);
      const ticks = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
      const labs = ticks.map((v) => '<line x1="' + l + '" x2="' + (W - r) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"></line><text x="' + (l - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + String(v).replace('-', '−') + '°</text>').join('');
      const box = '';
      const lines = series.map((s) => (s.list.length > 1 ? '<polyline fill="none" stroke="' + s.color + '" stroke-width="' + s.w + '" stroke-linejoin="round"' + (s.dash ? ' stroke-dasharray="4 4"' : '') + ' points="' + s.list.filter((p) => p.t >= t0).map((p) => x(p.t).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' ') + '"></polyline>' : '')).join('');
      const marks = series.filter((s) => s.peak && s.list.length > 3).map((s) => {
        // the sun's peak: look only in daylight (09-16), so hand tests or evening heat don't count
        const sunHour = (t) => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
        const day = s.list.filter((q) => q.t >= t0 && sunHour(q.t) >= 9 && sunHour(q.t) < 16);
        if (day.length < 2) return '';
        const p = day.reduce((a, b) => (b.v > a.v ? b : a));
        const px = x(p.t), py = y(p.v);
        return '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="3.5" fill="' + s.color + '" stroke="var(--card)" stroke-width="1.5"></circle><text x="' + px.toFixed(1) + '" y="' + (py - 7).toFixed(1) + '" text-anchor="middle" style="fill:' + s.color + ';font-weight:600">' + p.v.toFixed(1) + '°</text>';
      }).join('');
      return box + labs + lines + marks;
    };
    const colors = { ground: 'var(--ground)', south: 'var(--first)', north: 'var(--north)' };
    const inside = panel(HEAT.map(({ key }) => ({ list: ser[key] || [], color: colors[key] || 'var(--muted)', w: 2.5, peak: key === 'south' })), 16, 54, 2);
    const outside = panel([{ list: so, color: 'var(--out)', w: 2, dash: true }], 86, 40, 4, 5);
    // ticks on whole clock hours (00, 06, 12, 18) plus "Now"
    const hourOf = (t) => +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
    const ticks = [];
    // keep a clock label only if it doesn't touch "Now" (right-aligned) or the left edge, measured in pixels
    // first label: the earliest 3-hour mark (00, 03, 06 …) that fits at the left edge, then every 6 hours
    let t1 = Math.ceil(t0 / 3600000) * 3600000;
    while (hourOf(t1) % 3 !== 0 || x(t1) < 18) t1 += 3600000;
    for (let t = t1; t < now; t += 6 * 3600000) if ((W - r) - x(t) > 38) ticks.push(t);
    const hours = ticks.map((t) => '<text x="' + x(t).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' + String(hourOf(t)).padStart(2, '0') + ':00</text>').join('') +
      '<text x="' + (W - r) + '" y="' + (H - 4) + '" text-anchor="end">Now</text>';
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
    $('main').scrollTop = 0;
  }
  function eloStatus() {
    const has = !!store.get('eloRefresh');
    const m = store.get('eloMeter');
    $('elo-status').textContent = !has ? 'No token saved.' : state.eloError ? state.eloError : state.tariffs && m ? 'Connected to meter …' + String(m.id).slice(-4) + '. Tariffs and consumption come from Eloverblik.' : 'Token saved. Connecting…';
  }
  function openSheet(open) {
    $('sheet').hidden = !open; $('sheet-backdrop').hidden = !open;
    if (open) { eloStatus(); $('elo-token').value = ''; $('elo-token').placeholder = store.get('eloRefresh') ? 'Token saved. Paste a new one to replace it.' : 'Paste the token from eloverblik.dk'; }
    if (open && state.homey) $('homey-name').textContent = 'Connected to ' + (state.homey.name || 'your Homey');
  }

  function wireUI() {
    $('login-btn').addEventListener('click', () => {
      location.href = ATHOM + '/oauth2/authorise?client_id=' + encodeURIComponent(C.clientId) + '&redirect_uri=' + encodeURIComponent(C.redirectUri) + '&response_type=code';
    });
    document.querySelectorAll('.tabbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('settings-btn').addEventListener('click', () => openSheet(true));
    $('sheet-close').addEventListener('click', () => openSheet(false));
    $('sheet-backdrop').addEventListener('click', () => { openSheet(false); closeDevice(); });
    $('zone-groups').addEventListener('click', (e) => { const t = e.target.closest('.tile[data-id]'); if (t) onTile(t.dataset.id); });
    $('zone-groups').addEventListener('keydown', (e) => { const t = e.target.closest('.tile[data-id]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onTile(t.dataset.id); } });
    $('dev-close').addEventListener('click', closeDevice);
    document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => { state.histTab = b.dataset.hist; renderHistory(); }));
    $('hh-room-chips').addEventListener('click', (e) => { const c = e.target.closest('[data-room]'); if (c) { state.hhRoom = c.dataset.room; renderHeatHistory(); } });
    $('dev-body').addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (b) devAction(b); });
    $('dev-body').addEventListener('change', (e) => { if (e.target.matches('input[data-act]')) devAction(e.target); });
    $('theme-select').addEventListener('change', (e) => { if (DEMO) mem.theme = e.target.value; else store.set('theme', e.target.value); applyTheme(); });
    $('elo-save').addEventListener('click', async () => {
      const v = $('elo-token').value.trim().replace(/^Bearer\s+/i, '');
      if (!v) { $('elo-status').textContent = 'Paste the token first.'; return; }
      ['eloAccess', 'eloMeter', 'tariffs', 'yesterday'].forEach((k) => store.del(k));
      store.set('eloRefresh', v);
      state.tariffs = null; state.yesterday = null;
      $('elo-token').value = '';
      $('elo-status').textContent = 'Checking the token with Eloverblik…';
      await loadEloverblik(true);
      eloStatus();
    });
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
      if (!hasTomorrow && nowHour() >= 13 && (!state.lastPriceTry || Date.now() - state.lastPriceTry > 10 * 60000)) { state.lastPriceTry = Date.now(); loadPrices().then(render).catch(() => {}); }
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
    state.tariffs = store.get('tariffs');
    state.forecast = getS('forecast');
    state.yesterday = store.get('yesterday');
    const cached = store.get('prices');
    if (cached && cached.day === dayKey(0)) { state.prices = cached.list.map(withAllIn); state.pricesDay = cached.day; }
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
    loadEloverblik().then(() => loadPrices()).then(render).catch(() => {});
    loadForecast().then(render).catch(() => {});
    setInterval(loadHeat, 10 * 60000);
    setInterval(() => loadEloverblik(), 60 * 60000);
    setInterval(() => loadForecast().then(render).catch(() => {}), 60 * 60000);
    setInterval(() => tick(false), (C.refreshSeconds || 15) * 1000);
    setInterval(() => tick(true), 10 * 60000);
  }

  boot();
})();
