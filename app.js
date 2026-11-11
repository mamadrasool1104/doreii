import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/* ================================================================== *
 * Helpers
 * ================================================================== */
const $ = (s) => document.querySelector(s);

// Safe DOM builder: strings become text nodes, so stored data is never parsed as HTML.
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
};

const faNum = new Intl.NumberFormat('fa-IR');
const fmtNum = (n) => (n == null || n === '' ? '—' : faNum.format(n));
const fmtKm = (n) => (n == null ? '—' : faNum.format(n) + ' کیلومتر');
const dateFmt = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', calendar: 'persian' });
const dtFmt = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', calendar: 'persian' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso + 'T12:00:00')) : '—');
const fmtDateTime = (iso) => (iso ? dtFmt.format(new Date(iso)) : '');
const todayISO = () => new Date().toLocaleDateString('en-CA');

// Accept Persian/Arabic digits and thousands separators in numeric fields.
const toAscii = (s) => String(s ?? '')
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0)
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[٬,\s]/g, '').replace(/٫/g, '.');
const parseIntField = (s) => { const t = toAscii(s); return /^\d+$/.test(t) ? Number(t) : NaN; };
const parseMoney = (s) => { const t = toAscii(s); if (t === '') return null; return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN; };

const CATS = [5000, 10000, 20000, 40000, null];
const catLabel = (c) => (c ? `هر ${fmtNum(c)} کیلومتر` : 'کارهای سفارشی / بدون زمان‌بندی');
const STATUS_LABEL = { overdue: 'عقب‌افتاده', soon: 'نزدیک سررسید', ok: 'در موعد', none: 'بدون زمان‌بندی' };
const ROLE_LABEL = { admin: 'مدیر', member: 'عضو' };

function show(view) {
  for (const id of ['auth-view', 'denied-view', 'app-view']) $('#' + id).hidden = id !== view;
}
function banner(msg, kind = 'error') {
  const b = $('#banner');
  if (!msg) { b.hidden = true; return; }
  b.className = 'banner ' + kind;
  b.textContent = msg;
  b.hidden = false;
}
const errText = (e) => (e && (e.message || e.error_description)) || 'مشکلی پیش آمد. دوباره تلاش کنید.';
function inlineError(id, msg) { const b = $(id); b.textContent = msg || ''; b.hidden = !msg; }

async function withBusy(button, busyText, fn) {
  const prev = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try { return await fn(); } finally { button.disabled = false; button.textContent = prev; }
}

// Show a Jalali (Persian) preview under every date input.
for (const inp of document.querySelectorAll('input[type=date]')) {
  const sp = el('span', { class: 'fa-preview' });
  inp.after(sp);
  const upd = () => { sp.textContent = inp.value ? fmtDate(inp.value) : ''; };
  inp.addEventListener('input', upd);
  inp.addEventListener('change', upd);
  inp._preview = upd;
}
const setDate = (inp, v) => { inp.value = v || ''; inp._preview?.(); };

/* ================================================================== *
 * Supabase client
 * ================================================================== */
const configured = SUPABASE_URL && SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
if (!configured) {
  const box = $('#config-error');
  box.textContent = 'Supabase تنظیم نشده است. فایل config.js را باز کنید و SUPABASE_URL و SUPABASE_ANON_KEY را وارد کنید (راهنمای README.md).';
  box.hidden = false;
  throw new Error('Supabase not configured');
}
// Only the PUBLIC anon key is used here. Data is protected by Row Level Security.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ================================================================== *
 * State
 * ================================================================== */
const state = {
  userId: null,
  member: null,
  vehicle: null,
  tasks: [],
  visits: [],            // each: {..., visit_tasks:[{task_id}], visit_notes:[...]}
  people: new Map(),     // user_id -> name
  view: 'dashboard',
  channel: null,
  hasSubscribed: false,
  reloadTimer: null,
  authMode: 'signin',
  editingVisitId: null,
  quickTask: null,
};
const person = (id) => state.people.get(id) || 'یکی از اعضای خانواده';
const taskById = (id) => state.tasks.find((t) => t.id === id);

/* ================================================================== *
 * Auth
 * ================================================================== */
function setAuthMode(mode) {
  state.authMode = mode;
  const up = mode === 'signup';
  $('#name-wrap').hidden = !up;
  $('#auth-submit').textContent = up ? 'ساخت حساب' : 'ورود';
  $('#auth-toggle').textContent = up ? 'حساب دارم' : 'ساخت حساب جدید';
  $('#auth-sub').textContent = up
    ? 'حساب بسازید و ایمیل خود را تأیید کنید. فقط اعضای دعوت‌شده به اطلاعات دسترسی دارند.'
    : 'برای دیدن اطلاعات مشترک خانواده وارد شوید.';
  $('#auth-password').autocomplete = up ? 'new-password' : 'current-password';
}
$('#auth-toggle').addEventListener('click', () => setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  banner('');
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  await withBusy($('#auth-submit'), 'لطفاً صبر کنید…', async () => {
    try {
      if (state.authMode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: {
            data: { display_name: $('#auth-name').value.trim() },
            emailRedirectTo: location.origin + location.pathname,
          },
        });
        if (error) throw error;
        if (!data.session) {
          banner('حساب ساخته شد. ایمیل خود را بررسی و لینک تأیید را باز کنید، سپس وارد شوید.', 'info');
          setAuthMode('signin');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      banner(errText(err));
    }
  });
});

async function signOut() {
  banner('');
  const { error } = await supabase.auth.signOut();
  if (error) banner(errText(error));
}
$('#btn-signout').addEventListener('click', signOut);
$('#denied-signout').addEventListener('click', signOut);
$('#denied-retry').addEventListener('click', () => withBusy($('#denied-retry'), 'در حال بررسی…', async () => {
  const { data } = await supabase.auth.getSession();
  state.userId = null;
  await handleSession(data.session);
}));

// Do not await Supabase calls directly inside this callback (deadlock risk): defer it.
supabase.auth.onAuthStateChange((_event, session) => { setTimeout(() => handleSession(session), 0); });

async function handleSession(session) {
  if (!session) {
    teardown();
    state.userId = null; state.member = null;
    show('auth-view');
    return;
  }
  if (state.userId === session.user.id && state.member) return; // token refresh etc.
  state.userId = session.user.id;
  await bootstrap(session.user);
}

async function bootstrap(user) {
  banner('');
  show('app-view');
  const ok = await loadAll(false);
  if (!ok) return;
  if (!state.member) { $('#denied-email').textContent = user.email || ''; show('denied-view'); return; }
  subscribe();
  route();
}

/* ================================================================== *
 * Data loading  (the cloud database is the only source of truth)
 * ================================================================== */
async function loadAll(silent) {
  if (!silent) $('#loading').hidden = false;
  try {
    const [members, vehicles, tasks, visits] = await Promise.all([
      supabase.from('family_members').select('user_id, display_name, email, role'),
      supabase.from('vehicles').select('*').order('created_at').limit(1),
      supabase.from('maintenance_tasks').select('*').order('sort_order').order('created_at'),
      supabase.from('service_visits')
        .select('*, visit_tasks(task_id), visit_notes(id, body, created_by, created_at)')
        .order('service_date', { ascending: false }).order('mileage', { ascending: false }),
    ]);
    for (const r of [members, vehicles, tasks, visits]) if (r.error) throw r.error;

    state.people = new Map(members.data.map((m) => [m.user_id, m.display_name || m.email]));
    const me = members.data.find((m) => m.user_id === state.userId) || null;
    if (!me) { // not a member (or removed while online)
      state.member = null;
      if (state.channel) teardownChannel();
      if (!silent) $('#loading').hidden = true;
      else { const { data } = await supabase.auth.getUser(); $('#denied-email').textContent = data.user?.email || ''; show('denied-view'); }
      return true;
    }
    state.member = me;
    state.vehicle = vehicles.data[0] || null;
    state.tasks = tasks.data;
    for (const v of visits.data) v.visit_notes.sort((a, b) => a.created_at.localeCompare(b.created_at));
    state.visits = visits.data;

    $('#who').textContent = `${me.display_name || me.email} (${ROLE_LABEL[me.role]})`;
    $('#btn-members').hidden = me.role !== 'admin';
    renderAll();
    return true;
  } catch (err) {
    banner('خطا در دریافت اطلاعات: ' + errText(err));
    return false;
  } finally {
    $('#loading').hidden = true;
  }
}

/* ================================================================== *
 * Maintenance logic
 * ================================================================== */
const currentKm = () => state.vehicle?.current_mileage ?? 0;

function taskInfo(task) {
  let last = null;
  for (const v of state.visits) {
    if (!v.visit_tasks.some((t) => t.task_id === task.id)) continue;
    if (!last || v.mileage > last.mileage || (v.mileage === last.mileage && v.service_date > last.service_date)) last = v;
  }
  const cur = currentKm();
  const interval = task.interval_km;
  let nextDue = null, remaining = null, status = 'none';
  if (interval) {
    nextDue = (last ? last.mileage : 0) + interval;
    remaining = nextDue - cur;
    status = remaining <= 0 ? 'overdue' : remaining <= Math.max(500, interval * 0.1) ? 'soon' : 'ok';
  } else if (last) status = 'ok';
  const done = !!last && (!interval || cur < nextDue);
  return { last, nextDue, remaining, status, done };
}

function lastVisit() {
  let best = null;
  for (const v of state.visits) {
    if (!best || v.service_date > best.service_date || (v.service_date === best.service_date && v.mileage > best.mileage)) best = v;
  }
  return best;
}

/* ================================================================== *
 * Rendering
 * ================================================================== */
function renderAll() {
  if (!state.member) return;
  renderDashboard();
  renderChecklist();
  renderHistory();
}

function badge(status) { return el('span', { class: 'badge ' + status }, STATUS_LABEL[status]); }

function renderDashboard() {
  const infos = state.tasks.map((t) => ({ t, i: taskInfo(t) }));
  const overdue = infos.filter((x) => x.i.status === 'overdue');
  const upcoming = infos.filter((x) => x.t.interval_km && x.i.status !== 'overdue')
    .sort((a, b) => a.i.remaining - b.i.remaining);
  const completed = infos.filter((x) => x.i.done)
    .sort((a, b) => b.i.last.service_date.localeCompare(a.i.last.service_date));
  const lv = lastVisit();

  const stat = (t, v, extra = '', cls = '') => el('div', { class: 'stat ' + cls }, el('span', {}, t), el('b', {}, v), extra && el('span', {}, extra));
  $('#dash-vehicle').replaceChildren(
    stat('خودرو', state.vehicle?.name || '—', '', 'vehicle'),
    el('div', { class: 'stat' }, el('span', {}, 'کیلومتر فعلی'), el('b', {}, fmtKm(state.vehicle?.current_mileage)),
      el('button', { onclick: openKmDialog }, 'ثبت کیلومتر جدید')),
    stat('آخرین تاریخ سرویس', lv ? fmtDate(lv.service_date) : 'هنوز ثبت نشده'),
    stat('کیلومتر آخرین سرویس', lv ? fmtKm(lv.mileage) : '—'),
  );

  $('#dash-alerts').replaceChildren(...(overdue.length ? [el('div', { class: 'banner warn' },
    el('b', {}, `⚠ ${fmtNum(overdue.length)} سرویس عقب‌افتاده است: `),
    overdue.map((x, k) => (k ? '، ' : '') + `${x.t.title} (${fmtNum(-x.i.remaining)} کیلومتر دیرتر از موعد)`).join(''))] : []));

  $('#dash-upcoming').replaceChildren(...(upcoming.length
    ? upcoming.slice(0, 8).map(({ t, i }) => el('div', { class: 'item' },
        el('div', { class: 'body' }, el('div', { class: 'title' }, t.title),
          el('div', { class: 'sub' }, `در ${fmtKm(i.nextDue)} — ${fmtKm(i.remaining)} مانده`)),
        badge(i.status)))
    : [el('p', { class: 'muted' }, 'سرویس زمان‌بندی‌شده‌ای وجود ندارد.')]));

  $('#dash-completed').replaceChildren(...(completed.length
    ? completed.slice(0, 8).map(({ t, i }) => el('div', { class: 'item' },
        el('div', { class: 'body' }, el('div', { class: 'title' }, '✅ ' + t.title),
          el('div', { class: 'sub' }, `${fmtDate(i.last.service_date)} · ${fmtKm(i.last.mileage)}`))))
    : [el('p', { class: 'muted' }, 'هنوز سرویسی ثبت نشده است.')]));

  $('#dash-recent').replaceChildren(...(state.visits.length
    ? state.visits.slice(0, 5).map(visitCard)
    : [el('p', { class: 'muted' }, 'هنوز هیچ سرویسی ثبت نشده است. از بخش «تاریخچه سرویس» اولین مورد را ثبت کنید.')]));
}

function renderChecklist() {
  const body = $('#checklist-body');
  const groups = CATS.map((c) => {
    const items = state.tasks.filter((t) => (c ? t.interval_km === c : !t.interval_km || !CATS.includes(t.interval_km)));
    return { c, items };
  }).filter((g) => g.items.length);

  body.replaceChildren(...groups.map(({ c, items }) => el('div', { class: 'group' },
    el('h3', {}, catLabel(c)),
    el('div', { class: 'card' }, items.map(taskRow)))));
}

function taskRow(task) {
  const info = taskInfo(task);
  const { last } = info;
  const lastNote = last?.visit_notes.length ? last.visit_notes[last.visit_notes.length - 1].body : '';
  const box = el('input', {
    type: 'checkbox', class: 'big', 'aria-label': task.title, checked: info.done,
    onclick: (e) => {
      e.preventDefault(); // state only changes after the database confirms a change
      if (info.done && last) openVisitDialog(last);
      else openQuickDialog(task);
    },
  });
  return el('div', { class: 'item' }, box,
    el('div', { class: 'body' },
      el('div', { class: 'title' }, task.title, ' ', badge(info.status)),
      last
        ? el('div', { class: 'sub' }, `آخرین انجام: ${fmtDate(last.service_date)} · ${fmtKm(last.mileage)} · ثبت: ${person(last.created_by)}`)
        : el('div', { class: 'sub' }, 'تاکنون ثبت نشده'),
      task.interval_km && el('div', { class: 'sub' },
        `سررسید بعدی: ${fmtKm(info.nextDue)}` + (info.remaining > 0 ? ` (${fmtKm(info.remaining)} مانده)` : ` (${fmtKm(-info.remaining)} دیرتر از موعد)`)),
      lastNote && el('div', { class: 'sub' }, '📝 ' + (lastNote.length > 140 ? lastNote.slice(0, 140) + '…' : lastNote))));
}

function visitCard(v) {
  const tasks = v.visit_tasks.map((x) => taskById(x.task_id)).filter(Boolean);
  return el('article', { class: 'card visit' },
    el('div', { class: 'head' },
      el('span', { class: 'date' }, fmtDate(v.service_date) + ' · ' + fmtKm(v.mileage)),
      el('button', { onclick: () => openVisitDialog(v) }, 'ویرایش / افزودن یادداشت')),
    el('div', { class: 'meta' },
      v.shop_name && el('span', {}, '🔧 ' + v.shop_name),
      v.total_cost != null && el('span', {}, '💰 ' + fmtNum(Number(v.total_cost)) + ' تومان'),
      el('span', {}, 'ثبت‌کننده: ' + person(v.created_by)),
      v.updated_by && v.updated_by !== v.created_by && el('span', {}, 'آخرین ویرایش: ' + person(v.updated_by))),
    tasks.length ? el('div', { class: 'chips' }, tasks.map((t) => el('span', { class: 'chip' }, t.title))) : null,
    v.parts_replaced && el('div', {}, el('span', { class: 'muted' }, 'قطعات: '), v.parts_replaced),
    v.visit_notes.length ? el('div', { class: 'notes' }, v.visit_notes.map((n) => el('div', { class: 'note' }, n.body,
      el('small', {}, `${person(n.created_by)} · ${fmtDateTime(n.created_at)}`)))) : null);
}

/* ---- History filters ---- */
function filteredVisits() {
  const q = $('#h-search').value.trim().toLowerCase();
  const from = $('#h-from').value, to = $('#h-to').value;
  const kmMin = parseIntField($('#h-kmmin').value), kmMax = parseIntField($('#h-kmmax').value);
  const cat = $('#h-cat').value;
  return state.visits.filter((v) => {
    if (from && v.service_date < from) return false;
    if (to && v.service_date > to) return false;
    if (!Number.isNaN(kmMin) && v.mileage < kmMin) return false;
    if (!Number.isNaN(kmMax) && v.mileage > kmMax) return false;
    const tasks = v.visit_tasks.map((x) => taskById(x.task_id)).filter(Boolean);
    if (cat) {
      const hit = tasks.some((t) => (cat === 'custom' ? !CATS.includes(t.interval_km) : t.interval_km === Number(cat)));
      if (!hit) return false;
    }
    if (q) {
      const hay = [v.shop_name, v.parts_replaced, person(v.created_by), ...v.visit_notes.map((n) => n.body), ...tasks.map((t) => t.title)]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(toAscii(q).toLowerCase()) && !hay.includes(q)) return false;
    }
    return true;
  });
}

function renderHistory() {
  const rows = filteredVisits();
  $('#h-count').textContent = `${fmtNum(rows.length)} از ${fmtNum(state.visits.length)} سرویس`;
  $('#history-list').replaceChildren(...(rows.length ? rows.map(visitCard)
    : [el('p', { class: 'muted', style: 'text-align:center;padding:30px' },
        state.visits.length ? 'موردی با این فیلترها پیدا نشد.' : 'هنوز هیچ سرویسی ثبت نشده است.')]));
}
for (const id of ['#h-search', '#h-from', '#h-to', '#h-kmmin', '#h-kmmax', '#h-cat']) {
  $(id).addEventListener('input', renderHistory);
}
$('#h-reset').addEventListener('click', () => {
  for (const id of ['#h-search', '#h-kmmin', '#h-kmmax']) $(id).value = '';
  setDate($('#h-from'), ''); setDate($('#h-to'), '');
  $('#h-cat').value = '';
  renderHistory();
});

/* ---- CSV export (Excel-compatible) ---- */
function csvCell(v, text = true) {
  let s = String(v ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return '"' + s.replace(/"/g, '""') + '"';
}
$('#btn-export').addEventListener('click', () => {
  const rows = filteredVisits();
  if (!rows.length) { banner('موردی برای خروجی گرفتن وجود ندارد.', 'info'); return; }
  const head = ['تاریخ (میلادی)', 'تاریخ (شمسی)', 'کیلومتر', 'تعمیرگاه', 'کارهای انجام‌شده', 'قطعات تعویض‌شده', 'هزینه کل (تومان)', 'یادداشت‌ها', 'ثبت‌کننده'];
  const lines = [head.map((h) => csvCell(h)).join(',')];
  for (const v of rows) {
    const tasks = v.visit_tasks.map((x) => taskById(x.task_id)?.title).filter(Boolean).join(' | ');
    const notes = v.visit_notes.map((n) => `${n.body} (${person(n.created_by)})`).join(' | ');
    lines.push([
      csvCell(v.service_date, false), csvCell(fmtDate(v.service_date)), csvCell(v.mileage, false), csvCell(v.shop_name),
      csvCell(tasks), csvCell(v.parts_replaced), csvCell(v.total_cost ?? '', false), csvCell(notes), csvCell(person(v.created_by)),
    ].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `service-history-${todayISO()}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ================================================================== *
 * Dialogs: service visit (create / edit / add notes)
 * ================================================================== */
function openVisitDialog(visit = null, presetTaskIds = []) {
  state.editingVisitId = visit ? visit.id : null;
  $('#visit-title').textContent = visit ? 'ویرایش سرویس / افزودن یادداشت' : 'ثبت سرویس جدید';
  inlineError('#visit-error', '');
  setDate($('#v-date'), visit?.service_date ?? todayISO());
  $('#v-km').value = visit ? visit.mileage : (currentKm() || '');
  $('#v-shop').value = visit?.shop_name ?? '';
  $('#v-cost').value = visit?.total_cost ?? '';
  $('#v-parts').value = visit?.parts_replaced ?? '';
  $('#v-note').value = '';
  $('#v-note-label').textContent = visit ? 'افزودن یادداشت جدید (یادداشت‌های قبلی حفظ می‌شوند)' : 'یادداشت';

  const selected = new Set(visit ? visit.visit_tasks.map((x) => x.task_id) : presetTaskIds);
  $('#v-tasks').replaceChildren(...CATS.flatMap((c) => {
    const items = state.tasks.filter((t) => (c ? t.interval_km === c : !t.interval_km || !CATS.includes(t.interval_km)));
    if (!items.length) return [];
    return [el('h4', {}, catLabel(c)),
      ...items.map((t) => el('label', { class: 'chk' },
        el('input', { type: 'checkbox', value: t.id, checked: selected.has(t.id) }), t.title))];
  }));

  $('#v-oldnotes').replaceChildren(...(visit?.visit_notes.length ? [
    el('label', {}, 'یادداشت‌های قبلی'),
    ...visit.visit_notes.map((n) => el('div', { class: 'note' }, n.body,
      el('small', {}, `${person(n.created_by)} · ${fmtDateTime(n.created_at)}`)))] : []));
  $('#visit-dialog').showModal();
}
$('#btn-new-visit').addEventListener('click', () => openVisitDialog());
$('#visit-cancel').addEventListener('click', () => $('#visit-dialog').close());

async function saveVisit({ id, date, km, shop, parts, cost, taskIds, note }) {
  const { error } = await supabase.rpc('save_service_visit', {
    p_visit_id: id, p_vehicle_id: state.vehicle.id, p_date: date, p_mileage: km,
    p_shop: shop, p_parts: parts, p_cost: cost, p_task_ids: taskIds, p_note: note,
  });
  if (error) throw error;
  await loadAll(true); // re-read from the cloud: the database is the source of truth
}

$('#visit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#visit-error', '');
  const km = parseIntField($('#v-km').value);
  const cost = parseMoney($('#v-cost').value);
  if (Number.isNaN(km)) return inlineError('#visit-error', 'کیلومتر را فقط با عدد وارد کنید.');
  if (Number.isNaN(cost)) return inlineError('#visit-error', 'هزینه را فقط با عدد وارد کنید.');
  if (!state.vehicle) return inlineError('#visit-error', 'خودرویی در پایگاه داده پیدا نشد. فایل schema.sql را اجرا کنید.');
  const taskIds = [...$('#v-tasks').querySelectorAll('input:checked')].map((i) => i.value);
  await withBusy($('#visit-save'), 'در حال ذخیره…', async () => {
    try {
      await saveVisit({
        id: state.editingVisitId, date: $('#v-date').value, km, shop: $('#v-shop').value, parts: $('#v-parts').value,
        cost, taskIds, note: $('#v-note').value,
      });
      $('#visit-dialog').close();
    } catch (err) {
      inlineError('#visit-error', 'ذخیره نشد: ' + errText(err));
    }
  });
});

/* ---- Quick completion from the checklist ---- */
function openQuickDialog(task) {
  state.quickTask = task;
  $('#quick-title').textContent = 'ثبت انجام: ' + task.title;
  inlineError('#quick-error', '');
  setDate($('#q-date'), todayISO());
  $('#q-km').value = currentKm() || '';
  $('#q-shop').value = '';
  $('#q-note').value = '';
  $('#quick-dialog').showModal();
}
$('#quick-cancel').addEventListener('click', () => $('#quick-dialog').close());
$('#quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#quick-error', '');
  const km = parseIntField($('#q-km').value);
  if (Number.isNaN(km)) return inlineError('#quick-error', 'کیلومتر را فقط با عدد وارد کنید.');
  if (!state.vehicle) return inlineError('#quick-error', 'خودرویی در پایگاه داده پیدا نشد.');
  await withBusy($('#quick-save'), 'در حال ثبت…', async () => {
    try {
      await saveVisit({
        id: null, date: $('#q-date').value, km, shop: $('#q-shop').value, parts: null, cost: null,
        taskIds: [state.quickTask.id], note: $('#q-note').value,
      });
      $('#quick-dialog').close();
    } catch (err) {
      inlineError('#quick-error', 'ثبت نشد: ' + errText(err));
    }
  });
});

/* ---- Custom task ---- */
$('#btn-add-task').addEventListener('click', () => {
  inlineError('#task-error', '');
  $('#t-title').value = ''; $('#t-km').value = '';
  $('#task-dialog').showModal();
});
$('#task-cancel').addEventListener('click', () => $('#task-dialog').close());
$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#task-error', '');
  const raw = $('#t-km').value.trim();
  const km = raw === '' ? null : parseIntField(raw);
  if (km !== null && (Number.isNaN(km) || km <= 0)) return inlineError('#task-error', 'کیلومتر تکرار باید یک عدد مثبت باشد.');
  await withBusy($('#task-save'), 'در حال افزودن…', async () => {
    try {
      const { error } = await supabase.from('maintenance_tasks')
        .insert({ title: $('#t-title').value.trim(), interval_km: km, is_custom: true, sort_order: 1000 });
      if (error) throw error.code === '23505' ? new Error('این کار قبلاً در فهرست وجود دارد.') : error;
      await loadAll(true);
      $('#task-dialog').close();
    } catch (err) {
      inlineError('#task-error', 'افزوده نشد: ' + errText(err));
    }
  });
});

/* ---- Current mileage ---- */
function openKmDialog() {
  inlineError('#km-error', '');
  $('#k-km').value = currentKm() || '';
  $('#km-dialog').showModal();
}
$('#km-cancel').addEventListener('click', () => $('#km-dialog').close());
$('#km-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#km-error', '');
  const km = parseIntField($('#k-km').value);
  if (Number.isNaN(km)) return inlineError('#km-error', 'کیلومتر را فقط با عدد وارد کنید.');
  if (!state.vehicle) return inlineError('#km-error', 'خودرویی در پایگاه داده پیدا نشد.');
  await withBusy($('#km-save'), 'در حال ذخیره…', async () => {
    try {
      const { error } = await supabase.from('vehicles').update({ current_mileage: km }).eq('id', state.vehicle.id);
      if (error) throw error;
      await loadAll(true);
      $('#km-dialog').close();
    } catch (err) {
      inlineError('#km-error', 'ذخیره نشد: ' + errText(err));
    }
  });
});

/* ================================================================== *
 * Members dialog (admins; enforced by RLS on the server)
 * ================================================================== */
async function loadMembers() {
  const body = $('#members-body');
  try {
    const [{ data: members, error }, { data: invites, error: e2 }] = await Promise.all([
      supabase.from('family_members').select('*').order('created_at'),
      supabase.from('family_invites').select('*').order('created_at'),
    ]);
    if (error) throw error;
    if (e2) throw e2;
    const rows = members.map((m) => el('tr', {},
      el('td', {}, m.display_name || '—'),
      el('td', { class: 'muted', dir: 'ltr' }, m.email),
      el('td', {}, el('select', {
        onchange: async (ev) => {
          inlineError('#members-error', '');
          const { error: err } = await supabase.from('family_members').update({ role: ev.target.value }).eq('user_id', m.user_id);
          if (err) { inlineError('#members-error', errText(err)); loadMembers(); }
        },
      }, el('option', { value: 'member', selected: m.role === 'member' }, 'عضو'),
         el('option', { value: 'admin', selected: m.role === 'admin' }, 'مدیر'))),
      el('td', {}, m.user_id === state.userId ? el('span', { class: 'muted' }, 'شما') : el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`${m.email} از خانواده حذف شود؟ (سوابق ثبت‌شده او باقی می‌ماند)`)) return;
          inlineError('#members-error', '');
          const { error: err } = await supabase.from('family_members').delete().eq('user_id', m.user_id);
          if (err) inlineError('#members-error', errText(err)); else loadMembers();
        },
      }, 'حذف'))));
    const inviteRows = invites.map((i) => el('tr', {},
      el('td', { colspan: 2, dir: 'ltr' }, i.email), el('td', {}, ROLE_LABEL[i.role] + ' (دعوت‌شده)'),
      el('td', {}, el('button', {
        onclick: async () => {
          const { error: err } = await supabase.from('family_invites').delete().eq('email', i.email);
          if (err) inlineError('#members-error', errText(err)); else loadMembers();
        },
      }, 'لغو'))));
    body.className = '';
    body.replaceChildren(el('table', { class: 'simple' }, el('tbody', {}, rows, inviteRows)));
  } catch (err) {
    body.className = '';
    body.textContent = 'خطا در دریافت اعضا: ' + errText(err);
  }
}
$('#btn-members').addEventListener('click', () => {
  inlineError('#members-error', '');
  $('#members-body').className = 'spinner';
  $('#members-body').textContent = 'در حال دریافت…';
  $('#members-dialog').showModal();
  loadMembers();
});
$('#members-close').addEventListener('click', () => $('#members-dialog').close());
$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#members-error', '');
  await withBusy($('#invite-submit'), 'در حال دعوت…', async () => {
    const { data, error } = await supabase.rpc('invite_member', { p_email: $('#invite-email').value, p_role: $('#invite-role').value });
    if (error) { inlineError('#members-error', errText(error)); return; }
    $('#invite-email').value = '';
    if (data === 'invited') banner('دعوت ثبت شد. او باید با همین ایمیل حساب بسازد و ایمیلش را تأیید کند؛ سپس خودکار دسترسی می‌گیرد.', 'info');
    loadMembers();
  });
});

/* ================================================================== *
 * Realtime sync
 * ================================================================== */
function setSync(kind, text) { const s = $('#sync'); s.className = 'sync ' + kind; s.textContent = text; }

function scheduleReload() {
  clearTimeout(state.reloadTimer);
  state.reloadTimer = setTimeout(async () => {
    await loadAll(true);
    if ($('#members-dialog').open) loadMembers();
  }, 350);
}

function subscribe() {
  teardownChannel();
  setSync('', 'در حال اتصال…');
  let ch = supabase.channel('family-car-sync');
  for (const table of ['vehicles', 'maintenance_tasks', 'service_visits', 'visit_tasks', 'visit_notes', 'family_members']) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleReload);
  }
  state.channel = ch.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      setSync('live', 'همگام‌سازی زنده');
      if (state.hasSubscribed) loadAll(true); // reconnected: catch up on anything missed
      state.hasSubscribed = true;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      setSync('off', 'آفلاین – تلاش مجدد…');
    }
  });
}
function teardownChannel() {
  if (state.channel) { supabase.removeChannel(state.channel); state.channel = null; }
  state.hasSubscribed = false;
}
function teardown() {
  teardownChannel();
  clearTimeout(state.reloadTimer);
  state.vehicle = null; state.tasks = []; state.visits = [];
}

/* ================================================================== *
 * Routing (hash based, works on GitHub Pages)
 * ================================================================== */
function route() {
  const v = location.hash.replace('#', '');
  state.view = ['dashboard', 'checklist', 'history'].includes(v) ? v : 'dashboard';
  for (const name of ['dashboard', 'checklist', 'history']) $('#view-' + name).hidden = name !== state.view;
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.view === state.view);
}
window.addEventListener('hashchange', route);

/* ================================================================== *
 * Start
 * ================================================================== */
setAuthMode('signin');
show('auth-view'); // replaced by onAuthStateChange once the saved session (if any) is restored
