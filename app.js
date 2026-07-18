// ── Web/mobile mode ────────────────────────────────────────────────────────
const IS_WEB = !window.api;
if (IS_WEB) {
  const SYNC_KEY = 'cal-sync-url';
  const webValid = u => typeof u === 'string' && /^https:\/\/[^\s]+\.json$/.test(u.trim());
  const getUrl = () => (localStorage.getItem(SYNC_KEY) || '').trim();
  const EMPTY = () => ({ events: [], weekly: [], banners: [], kidsDays: [], travelDays: {}, holidays: [], schoolHols: {}, suppressedWeekly: [], categories: {} });
  window.api = {
    loadData: async () => {
      const url = getUrl();
      if (!webValid(url)) return Object.assign(EMPTY(), { _needsSetup: true });
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      return (j && typeof j === 'object') ? j : EMPTY();
    },
    saveData: async (d) => {
      const url = getUrl();
      if (!webValid(url)) return { ok: false };
      d.updatedAt = Date.now();
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return { ok: true };
    },
    getSyncUrl: async () => getUrl(),
    setSyncUrl: async (u) => {
      const t = (u || '').trim();
      if (t && !webValid(t)) return { ok: false, error: "That doesn't look like a sync code (it should start with https:// and end in .json)" };
      localStorage.setItem(SYNC_KEY, t);
      return { ok: true };
    },
    getSyncStatus: async () => ({ state: webValid(getUrl()) ? 'ok' : 'off', configured: webValid(getUrl()), lastSync: null, error: null }),
    syncNow: async () => ({ ok: true }),
    onRemoteUpdate: () => {},
    onSyncStatus: () => {},
  };
}

// ── Constants & state ──────────────────────────────────────────────────────
const TODAY = new Date().toISOString().split('T')[0];
const DEFAULT_COLOR = '#8b8b8b';
let DATA = { events: [], weekly: [], banners: [], kidsDays: [], travelDays: {}, holidays: [], schoolHols: {}, suppressedWeekly: [], categories: {} };
let viewYear = +TODAY.slice(0, 4);
let viewMonth = +TODAY.slice(5, 7) - 1; // 0-11
let dayCtx = null;        // date string open in day modal
let editCtx = null;       // event being edited
let seriesCtx = null;     // weekly series being edited
let agStart = TODAY;      // agenda window
let agDays = 60;
let agShowPast = false;

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function addDaysStr(ds, n) { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dowOf(ds) { return new Date(ds + 'T00:00:00').getDay(); }
function fmtLong(ds) { return new Date(ds + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
function fmtShort(ds) { return new Date(ds + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase(); }
function catColor(c) { return (DATA.categories || {})[c] || DEFAULT_COLOR; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}
function ensureDefaults(d) {
  if (!d.events) d.events = [];
  if (!d.weekly) d.weekly = [];
  if (!d.banners) d.banners = [];
  if (!d.kidsDays) d.kidsDays = [];
  if (!d.travelDays) d.travelDays = {};
  if (!d.holidays) d.holidays = [];
  if (!d.schoolHols) d.schoolHols = {};
  if (!d.suppressedWeekly) d.suppressedWeekly = [];
  if (!d.categories) d.categories = {};
  return d;
}
async function save() {
  try {
    await window.api.saveData(DATA);
    toast('Saved');
  } catch (e) {
    toast('Save failed — check your internet connection');
  }
}

// ── Event lookup ───────────────────────────────────────────────────────────
function weeklyOccurrences(ds) {
  const dow = dowOf(ds);
  const out = [];
  for (const w of DATA.weekly) {
    if (+w.dow !== dow) continue;
    if (w.startDate && ds < w.startDate) continue;
    if (w.endDate && ds > w.endDate) continue;
    const id = `wk-${w.id}-${ds}`;
    if (DATA.suppressedWeekly.includes(id)) continue;
    out.push({ id, date: ds, title: w.title, category: w.category || '', status: w.status || '', isWeekly: true, weeklyId: w.id });
  }
  return out;
}
function eventsOn(ds) {
  return [...DATA.events.filter(e => e.date === ds), ...weeklyOccurrences(ds)];
}
function bannersOn(ds) { return DATA.banners.filter(b => b.date === ds); }
function holidaysOn(ds) { return DATA.holidays.filter(h => h.date === ds); }

// ── Month view ─────────────────────────────────────────────────────────────
function renderMonth() {
  document.getElementById('cal-title').textContent =
    new Date(viewYear, viewMonth, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

  const first = new Date(viewYear, viewMonth, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first offset
  const gridStart = new Date(viewYear, viewMonth, 1 - lead);
  const grid = document.getElementById('cal-grid');
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const inMonth = d.getMonth() === viewMonth;
    const evts = eventsOn(ds);
    const bans = bannersOn(ds);
    const hols = holidaysOn(ds);
    const sch = DATA.schoolHols[ds];
    const isKids = DATA.kidsDays.includes(ds);
    const travel = DATA.travelDays[ds];

    const chips = evts.slice(0, 3).map(e =>
      `<div class="chip ${e.status === 'Done' ? 'done' : ''}"><span class="cdot" style="background:${catColor(e.category)}"></span>${esc(e.title)}</div>`).join('');
    const more = evts.length > 3 ? `<div class="chip-more">+${evts.length - 3} more</div>` : '';
    const banner = bans.length ? `<div class="cell-banner">${esc(bans[0].text)}${bans.length > 1 ? ' +' : ''}</div>` : '';
    const htags = (sch === 'QLD' || sch === 'BOTH' ? '<span class="htag q">Q·HOL</span>' : '') +
                  (sch === 'WA' || sch === 'BOTH' ? '<span class="htag w">W·HOL</span>' : '');
    const bars = (isKids ? '<div class="bar kids" title="Kids in QLD"></div>' : '') +
                 (travel ? '<div class="bar travel"></div>' : '');
    html += `<div class="cal-cell ${inMonth ? '' : 'other'} ${ds === TODAY ? 'today' : ''}" data-date="${ds}">
      <div class="cell-top"><span class="cell-num ${hols.length ? 'ph' : ''}">${d.getDate()}</span>${htags}</div>
      ${banner}${chips}${more}
      <div class="cell-bars">${bars}</div>
    </div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.cal-cell').forEach(c => c.addEventListener('click', () => openDay(c.dataset.date)));
  renderUpcoming();
}

function renderUpcoming() {
  const el = document.getElementById('upcoming');
  let html = '';
  for (let i = 0; i < 7; i++) {
    const ds = addDaysStr(TODAY, i);
    const evts = eventsOn(ds).filter(e => e.status !== 'Done');
    const hols = holidaysOn(ds);
    const bans = bannersOn(ds);
    const bits = [
      ...hols.map(h => `<span style="color:#f87171">${esc(h.name)}</span>`),
      ...bans.map(b => `<span style="color:#a78bfa">${esc(b.text)}</span>`),
      ...evts.map(e => `<span class="up-dot" style="background:${catColor(e.category)}"></span>${esc(e.title)}`),
    ];
    if (!bits.length) continue;
    html += `<div class="up-day"><span class="up-date">${i === 0 ? 'TODAY' : fmtShort(ds)}</span><span class="up-evts">${bits.join(' &nbsp;·&nbsp; ')}</span></div>`;
  }
  el.innerHTML = html || '<div class="empty">Nothing on in the next 7 days</div>';
}

// ── Day modal ──────────────────────────────────────────────────────────────
function populateCats(sel, withBlank = true) {
  const cats = Object.keys(DATA.categories || {}).sort();
  sel.innerHTML = (withBlank ? '<option value="">— no category —</option>' : '') +
    cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

function openDay(ds) {
  dayCtx = ds;
  document.getElementById('dm-title').textContent = fmtLong(ds);
  const dowName = new Date(ds + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long' });
  document.getElementById('dm-weekly-label').textContent = `Repeat every ${dowName}`;
  populateCats(document.getElementById('dm-new-cat'));
  renderDayMeta();
  renderDayEvents();
  document.getElementById('dm-new-title').value = '';
  document.getElementById('dm-new-banner').value = '';
  document.getElementById('dm-new-weekly').checked = false;
  document.getElementById('day-modal').classList.add('open');
}

function renderDayMeta() {
  const ds = dayCtx;
  const sch = DATA.schoolHols[ds];
  const tags = [
    ...holidaysOn(ds).map(h => `<span class="meta-tag ph">${esc(h.name)}${h.scope && h.scope !== 'Australia-wide' ? ' (' + esc(h.scope) + ')' : ''}</span>`),
    (sch === 'QLD' || sch === 'BOTH') ? '<span class="meta-tag q">QLD School Hols</span>' : '',
    (sch === 'WA' || sch === 'BOTH') ? '<span class="meta-tag w">WA School Hols</span>' : '',
    DATA.kidsDays.includes(ds) ? `<span class="meta-tag kids">Kids in QLD <span class="x" data-act="kids">&#x2715;</span></span>` : '',
    DATA.travelDays[ds] ? `<span class="meta-tag travel">${esc(DATA.travelDays[ds])} <span class="x" data-act="travel">&#x2715;</span></span>` : '',
    ...bannersOn(ds).map(b => `<span class="meta-tag banner">${esc(b.text)} <span class="x" data-act="banner" data-id="${b.id}">&#x2715;</span></span>`),
    !DATA.kidsDays.includes(ds) ? `<span class="meta-tag kids" style="opacity:.45;cursor:pointer" data-act="addkids">+ Kids in QLD</span>` : '',
  ].filter(Boolean).join('');
  const el = document.getElementById('dm-meta');
  el.innerHTML = tags;
  el.querySelectorAll('[data-act]').forEach(x => x.addEventListener('click', async () => {
    const act = x.dataset.act;
    if (act === 'kids') DATA.kidsDays = DATA.kidsDays.filter(d => d !== dayCtx);
    if (act === 'addkids' && !DATA.kidsDays.includes(dayCtx)) DATA.kidsDays.push(dayCtx);
    if (act === 'travel') delete DATA.travelDays[dayCtx];
    if (act === 'banner') DATA.banners = DATA.banners.filter(b => b.id !== x.dataset.id);
    await save(); renderDayMeta(); renderAll();
  }));
}

function statusCycle(s) { return s === '' ? 'Tentative' : s === 'Tentative' ? 'Confirmed' : s === 'Confirmed' ? 'Done' : ''; }

function renderDayEvents() {
  const evts = eventsOn(dayCtx);
  const el = document.getElementById('dm-events');
  el.innerHTML = evts.length ? evts.map(e => `
    <div class="dm-evt ${e.status === 'Done' ? 'done' : ''}">
      <span class="cdot" style="background:${catColor(e.category)}"></span>
      <span class="t">${esc(e.title)} ${e.isWeekly ? '<span class="wk-tag">&#8635; weekly</span>' : ''}<br><span class="cat">${esc(e.category || '')}</span></span>
      <span class="status-badge ${e.status || 'none'}" data-id="${e.id}">${e.status || 'set status'}</span>
      <button class="icon-btn" data-edit="${e.id}" title="Edit">&#9998;</button>
      <button class="icon-btn del" data-del="${e.id}" title="${e.isWeekly ? 'Skip just this week' : 'Delete'}">&#x2715;</button>
    </div>`).join('') : '<div class="empty">Nothing on this day yet</div>';

  el.querySelectorAll('.status-badge').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    const real = DATA.events.find(e => e.id === id);
    if (real) { real.status = statusCycle(real.status || ''); }
    else {
      // weekly occurrence: materialize with new status
      const occ = eventsOn(dayCtx).find(e => e.id === id);
      if (occ) {
        DATA.suppressedWeekly.push(occ.id);
        DATA.events.push({ id: 'ev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), date: occ.date, title: occ.title, category: occ.category, status: statusCycle(occ.status || ''), fromWeekly: occ.weeklyId });
      }
    }
    await save(); renderDayEvents(); renderAll();
  }));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.edit;
    const real = DATA.events.find(e => e.id === id);
    if (real) openEdit(real);
    else {
      const occ = eventsOn(dayCtx).find(e => e.id === id);
      if (occ) openSeries(DATA.weekly.find(w => w.id === occ.weeklyId));
    }
  }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    if (DATA.events.find(e => e.id === id)) {
      DATA.events = DATA.events.filter(e => e.id !== id);
    } else {
      DATA.suppressedWeekly.push(id); // skip this occurrence only
    }
    await save(); renderDayEvents(); renderAll();
  }));
}

// ── Edit event modal ───────────────────────────────────────────────────────
function openEdit(ev) {
  editCtx = ev.id;
  populateCats(document.getElementById('em-cat'));
  document.getElementById('em-t').value = ev.title;
  document.getElementById('em-cat').value = ev.category || '';
  document.getElementById('em-status').value = ev.status || '';
  document.getElementById('em-date').value = ev.date;
  document.getElementById('edit-modal').classList.add('open');
}

// ── Weekly series modal ────────────────────────────────────────────────────
function openSeries(w) {
  if (!w) return;
  seriesCtx = w.id;
  populateCats(document.getElementById('sm-cat'));
  document.getElementById('sm-t').value = w.title;
  document.getElementById('sm-cat').value = w.category || '';
  document.getElementById('sm-dow').value = String(w.dow);
  document.getElementById('sm-start').value = w.startDate || '';
  document.getElementById('sm-end').value = w.endDate || '';
  document.getElementById('series-modal').classList.add('open');
}

// ── Agenda ─────────────────────────────────────────────────────────────────
function renderAgenda() {
  const q = document.getElementById('ag-search').value.trim().toLowerCase();
  const cat = document.getElementById('ag-cat').value;
  const el = document.getElementById('agenda-list');
  document.getElementById('ag-earlier').style.display = (q || !agShowPast) ? 'none' : '';
  document.getElementById('ag-later').style.display = q ? 'none' : '';

  if (q) {
    // Search everything, newest first
    const hits = DATA.events.filter(e =>
      e.title.toLowerCase().includes(q) && (!cat || e.category === cat)
    ).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 200);
    el.innerHTML = hits.length ? hits.map(e => `
      <div class="ag-day"><div class="ag-date" data-date="${e.date}">${fmtShort(e.date)} ${e.date.slice(0, 4)}</div>
      <div class="ag-evt ${e.status === 'Done' ? 'done' : ''}"><span class="cdot" style="background:${catColor(e.category)}"></span><span class="t">${esc(e.title)}</span><span class="status-badge ${e.status || 'none'}" style="cursor:default">${e.status || '—'}</span></div></div>`).join('')
      : '<div class="empty">No events match your search</div>';
  } else {
    const start = agShowPast ? addDaysStr(TODAY, -agDays) : agStart;
    let html = '';
    for (let i = 0; i < (agShowPast ? agDays * 2 : agDays); i++) {
      const ds = addDaysStr(start, i);
      let evts = eventsOn(ds);
      if (cat) evts = evts.filter(e => e.category === cat);
      const hols = holidaysOn(ds);
      const bans = bannersOn(ds);
      if (!evts.length && !hols.length && !bans.length) continue;
      const minis = [
        ...hols.map(h => `<span class="mini" style="background:#f8717122;color:#f87171">${esc(h.name)}</span>`),
        ...bans.map(b => `<span class="mini" style="background:#a78bfa22;color:#a78bfa">${esc(b.text)}</span>`),
        DATA.kidsDays.includes(ds) ? '<span class="mini" style="background:#fb923c22;color:#fb923c">KIDS QLD</span>' : '',
        DATA.travelDays[ds] ? `<span class="mini" style="background:#38bdf822;color:#38bdf8">${esc(DATA.travelDays[ds])}</span>` : '',
      ].filter(Boolean).join('');
      html += `<div class="ag-day">
        <div class="ag-date" data-date="${ds}">${ds === TODAY ? 'TODAY — ' : ''}${fmtShort(ds)} ${minis}</div>
        ${evts.map(e => `<div class="ag-evt ${e.status === 'Done' ? 'done' : ''}">
          <span class="cdot" style="background:${catColor(e.category)}"></span>
          <span class="t">${esc(e.title)} ${e.isWeekly ? '<span class="wk-tag">&#8635;</span>' : ''}</span>
          <span class="status-badge ${e.status || 'none'}" style="cursor:default">${e.status || '—'}</span>
        </div>`).join('')}
      </div>`;
    }
    el.innerHTML = html || '<div class="empty">Nothing scheduled in this window</div>';
  }
  el.querySelectorAll('.ag-date').forEach(h => h.addEventListener('click', () => openDay(h.dataset.date)));
}

// ── Render all ─────────────────────────────────────────────────────────────
function renderAll() {
  renderMonth();
  renderAgenda();
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
}

// ── Sync UI (same pattern as the finance app) ──────────────────────────────
function applyRemote(remote) {
  if (dayCtx || editCtx || seriesCtx) return;
  DATA = ensureDefaults(remote);
  renderAll();
  toast('Synced');
}
function renderSyncStatus(s) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.title = '';
  if (!s.configured) { el.textContent = 'Not connected'; el.style.color = '#555'; }
  else if (s.state === 'error') { el.textContent = 'Sync error'; el.style.color = '#f04a4a'; el.title = s.error || ''; }
  else if (s.state === 'connecting') { el.textContent = 'Connecting…'; el.style.color = '#e0a840'; }
  else { el.textContent = 'Synced ✓'; el.style.color = '#c8f04a'; }
}
async function webRefresh() {
  if (!IS_WEB || dayCtx || editCtx || seriesCtx) return;
  try {
    const remote = await window.api.loadData();
    if (remote && !remote._needsSetup && (remote.updatedAt || 0) > (DATA.updatedAt || 0)) applyRemote(remote);
  } catch (_) {}
}

// ── Wiring ─────────────────────────────────────────────────────────────────
function wireEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { switchTab(btn.dataset.tab); if (btn.dataset.tab === 'agenda') renderAgenda(); });
  });
  document.getElementById('cal-prev').addEventListener('click', () => { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderMonth(); });
  document.getElementById('cal-next').addEventListener('click', () => { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderMonth(); });
  document.getElementById('cal-today').addEventListener('click', () => { viewYear = +TODAY.slice(0, 4); viewMonth = +TODAY.slice(5, 7) - 1; renderMonth(); });

  // Day modal
  document.getElementById('dm-close').addEventListener('click', () => { document.getElementById('day-modal').classList.remove('open'); dayCtx = null; });
  document.getElementById('day-modal').addEventListener('click', e => { if (e.target.id === 'day-modal') { e.currentTarget.classList.remove('open'); dayCtx = null; } });
  document.getElementById('dm-add').addEventListener('click', async () => {
    const title = document.getElementById('dm-new-title').value.trim();
    if (!title) { toast('Type what the event is first'); return; }
    const category = document.getElementById('dm-new-cat').value;
    const status = document.getElementById('dm-new-status').value;
    if (document.getElementById('dm-new-weekly').checked) {
      DATA.weekly.push({ id: 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), dow: dowOf(dayCtx), title, category, startDate: dayCtx });
      toast('Weekly event added');
    } else {
      DATA.events.push({ id: 'ev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), date: dayCtx, title, category, status });
    }
    document.getElementById('dm-new-title').value = '';
    await save(); renderDayEvents(); renderAll();
  });
  document.getElementById('dm-add-banner').addEventListener('click', async () => {
    const t = document.getElementById('dm-new-banner').value.trim();
    if (!t) return;
    DATA.banners.push({ id: 'bn-' + Date.now(), date: dayCtx, text: t });
    document.getElementById('dm-new-banner').value = '';
    await save(); renderDayMeta(); renderAll();
  });

  // Edit modal
  document.getElementById('em-cancel').addEventListener('click', () => { document.getElementById('edit-modal').classList.remove('open'); editCtx = null; });
  document.getElementById('em-save').addEventListener('click', async () => {
    const ev = DATA.events.find(e => e.id === editCtx);
    if (ev) {
      const t = document.getElementById('em-t').value.trim();
      const d = document.getElementById('em-date').value;
      if (!t) { toast('Title can\'t be empty'); return; }
      if (!d) { toast('Pick a date'); return; }
      ev.title = t; ev.category = document.getElementById('em-cat').value;
      ev.status = document.getElementById('em-status').value; ev.date = d;
    }
    document.getElementById('edit-modal').classList.remove('open'); editCtx = null;
    await save(); if (dayCtx) renderDayEvents(); renderAll();
  });
  document.getElementById('em-delete').addEventListener('click', async () => {
    DATA.events = DATA.events.filter(e => e.id !== editCtx);
    document.getElementById('edit-modal').classList.remove('open'); editCtx = null;
    await save(); if (dayCtx) renderDayEvents(); renderAll();
  });

  // Series modal
  document.getElementById('sm-cancel').addEventListener('click', () => { document.getElementById('series-modal').classList.remove('open'); seriesCtx = null; });
  document.getElementById('sm-save').addEventListener('click', async () => {
    const w = DATA.weekly.find(x => x.id === seriesCtx);
    if (w) {
      const t = document.getElementById('sm-t').value.trim();
      if (!t) { toast('Title can\'t be empty'); return; }
      w.title = t; w.category = document.getElementById('sm-cat').value;
      w.dow = +document.getElementById('sm-dow').value;
      w.startDate = document.getElementById('sm-start').value || w.startDate;
      const end = document.getElementById('sm-end').value;
      if (end) w.endDate = end; else delete w.endDate;
    }
    document.getElementById('series-modal').classList.remove('open'); seriesCtx = null;
    await save(); if (dayCtx) renderDayEvents(); renderAll();
  });
  document.getElementById('sm-delete').addEventListener('click', async () => {
    DATA.weekly = DATA.weekly.filter(w => w.id !== seriesCtx);
    document.getElementById('series-modal').classList.remove('open'); seriesCtx = null;
    await save(); if (dayCtx) renderDayEvents(); renderAll();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ['day-modal', 'edit-modal', 'series-modal'].forEach(id => document.getElementById(id).classList.remove('open'));
      dayCtx = editCtx = seriesCtx = null;
    }
  });

  // Agenda
  document.getElementById('ag-search').addEventListener('input', renderAgenda);
  document.getElementById('ag-cat').addEventListener('change', renderAgenda);
  document.getElementById('ag-past').addEventListener('click', e => {
    agShowPast = !agShowPast;
    e.target.classList.toggle('active', agShowPast);
    renderAgenda();
  });
  document.getElementById('ag-later').addEventListener('click', () => { agDays += 60; renderAgenda(); });
  document.getElementById('ag-earlier').addEventListener('click', () => { agDays += 60; renderAgenda(); });

  // Sync
  document.getElementById('save-sync-btn').addEventListener('click', async () => {
    const url = document.getElementById('sync-url').value;
    const banner = document.getElementById('setup-banner');
    const firstRun = banner.style.display !== 'none';
    const r = await window.api.setSyncUrl(url);
    if (!r.ok) { toast(r.error || 'Invalid sync code'); return; }
    if (!url.trim()) { toast('Sync turned off'); renderSyncStatus({ configured: false }); return; }
    banner.style.display = 'none';
    if (IS_WEB) {
      try {
        const remote = await window.api.loadData();
        if (remote && !remote._needsSetup) applyRemote(remote);
        toast('Connected!');
        if (firstRun) switchTab('month');
      } catch (e) { toast('Could not reach the cloud — double-check the code'); }
    } else {
      toast('Connected!');
      if (firstRun) switchTab('month');
    }
    renderSyncStatus(await window.api.getSyncStatus());
  });

  // Backup
  document.getElementById('backup-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'calendar-backup-' + TODAY + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup downloaded');
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────
(async function init() {
  try {
    DATA = await window.api.loadData();
  } catch (e) {
    DATA = {};
    toast('Could not load from the cloud — check your connection');
  }
  const needsSetup = DATA._needsSetup;
  delete DATA._needsSetup;
  ensureDefaults(DATA);
  if (needsSetup) {
    document.getElementById('setup-banner').style.display = '';
    switchTab('sync');
  }
  populateCats(document.getElementById('ag-cat'), false);
  document.getElementById('ag-cat').insertAdjacentHTML('afterbegin', '<option value="" selected>All categories</option>');

  document.getElementById('sync-url').value = await window.api.getSyncUrl();
  renderSyncStatus(await window.api.getSyncStatus());
  window.api.onSyncStatus(renderSyncStatus);
  window.api.onRemoteUpdate(applyRemote);
  if (IS_WEB) {
    setInterval(webRefresh, 30000);
    window.addEventListener('focus', webRefresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) webRefresh(); });
  }

  wireEvents();
  renderAll();
})();
