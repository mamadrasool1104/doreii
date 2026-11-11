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

/* ---- Persian numbers & dates ---- */
const faNum = new Intl.NumberFormat('fa-IR');
const faPlain = new Intl.NumberFormat('fa-IR', { useGrouping: false });
const toFaDigits = (s) => String(s ?? '').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const fmtNum = (n) => (n == null || n === '' ? '—' : faNum.format(n));
const fmtKm = (n) => (n == null ? '—' : faNum.format(n) + ' کیلومتر');
const dateFmt = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', calendar: 'persian', numberingSystem: 'arabext' });
const dtFmt = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', calendar: 'persian', numberingSystem: 'arabext' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso + 'T12:00:00')) : '—');
const fmtDateTime = (iso) => (iso ? dtFmt.format(new Date(iso)) : '');
const pad2 = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

// Accept Persian/Arabic digits and separators typed by the user.
const toAscii = (s) => String(s ?? '')
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0)
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[٬,\s]/g, '').replace(/٫/g, '.');
const parseIntField = (s) => { const t = toAscii(s); return /^\d+$/.test(t) ? Number(t) : NaN; };
const parseMoney = (s) => { const t = toAscii(s); if (t === '') return null; return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN; };
const setNum = (inp, v) => { inp.value = v == null || v === '' ? '' : toFaDigits(v); };

// Numeric fields always show Persian digits while typing.
for (const inp of document.querySelectorAll('input[inputmode=numeric], input[inputmode=decimal]')) {
  inp.addEventListener('input', () => { if (/\d/.test(inp.value)) inp.value = toFaDigits(inp.value); });
}

/* ---- Jalali (Shamsi) calendar conversion ---- */
const jdiv = (a, b) => ~~(a / b);
const jmod = (a, b) => a - ~~(a / b) * b;
const J_BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
function jalCal(jy, withoutLeap) {
  const bl = J_BREAKS.length, gy = jy + 621;
  let leapJ = -14, jp = J_BREAKS[0], jm, jump = 0, leap, n;
  if (jy < jp || jy >= J_BREAKS[bl - 1]) throw new Error('invalid jalali year');
  for (let i = 1; i < bl; i += 1) {
    jm = J_BREAKS[i]; jump = jm - jp;
    if (jy < jm) break;
    leapJ += jdiv(jump, 33) * 8 + jdiv(jmod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;
  leapJ += jdiv(n, 33) * 8 + jdiv(jmod(n, 33) + 3, 4);
  if (jmod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = jdiv(gy, 4) - jdiv((jdiv(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (withoutLeap) return { gy, march };
  if (jump - n < 6) n = n - jump + jdiv(jump + 4, 33) * 33;
  leap = jmod(jmod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}
const g2d = (gy, gm, gd) => {
  let d = jdiv((gy + jdiv(gm - 8, 6) + 100100) * 1461, 4) + jdiv(153 * jmod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - jdiv(jdiv(gy + 100100 + jdiv(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
};
const d2g = (jdn) => {
  let j = 4 * jdn + 139361631;
  j += jdiv(jdiv(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = jdiv(jmod(j, 1461), 4) * 5 + 308;
  const gd = jdiv(jmod(i, 153), 5) + 1;
  const gm = jmod(jdiv(i, 153), 12) + 1;
  const gy = jdiv(j, 1461) - 100100 + jdiv(8 - gm, 6);
  return { gy, gm, gd };
};
const j2d = (jy, jm, jd) => {
  const r = jalCal(jy, true);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - jdiv(jm, 7) * (jm - 7) + jd - 1;
};
const d2j = (jdn) => {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy, false);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + jdiv(k, 31), jd: jmod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1; k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + jdiv(k, 30), jd: jmod(k, 30) + 1 };
};
const toJalali = (gy, gm, gd) => d2j(g2d(gy, gm, gd));
const toGregorian = (jy, jm, jd) => d2g(j2d(jy, jm, jd));
const isJalaliLeap = (jy) => jalCal(jy, false).leap === 0;
const jDaysInMonth = (jy, jm) => (jm <= 6 ? 31 : jm <= 11 ? 30 : isJalaliLeap(jy) ? 30 : 29);
const J_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

/* ---- Jalali date picker (three selects: day / month / year) ---- */
function initJDate(root) {
  const optional = root.hasAttribute('data-optional');
  const now = new Date();
  const thisYear = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate()).jy;
  const mk = (label) => el('select', { class: 'control', 'aria-label': label });
  const day = mk('روز'), month = mk('ماه'), year = mk('سال');
  const blank = (t) => el('option', { value: '' }, t);

  if (optional) { month.append(blank('ماه')); year.append(blank('سال')); }
  J_MONTHS.forEach((name, i) => month.append(el('option', { value: i + 1 }, name)));
  for (let y = thisYear + 1; y >= thisYear - 25; y--) year.append(el('option', { value: y }, faPlain.format(y)));

  function fillDays() {
    const keep = day.value;
    const y = Number(year.value), m = Number(month.value);
    const max = y && m ? jDaysInMonth(y, m) : 31;
    day.replaceChildren(...(optional ? [blank('روز')] : []));
    for (let d = 1; d <= max; d++) day.append(el('option', { value: d }, faPlain.format(d)));
    day.value = keep && Number(keep) <= max ? keep : (optional ? '' : String(max));
  }
  month.addEventListener('change', fillDays);
  year.addEventListener('change', fillDays);
  root.replaceChildren(day, month, year); // RTL: day sits on the right
  fillDays();

  root._jd = {
    // '' = empty, null = incomplete, otherwise a Gregorian ISO date for the database
    get() {
      if (!day.value && !month.value && !year.value) return '';
      if (!day.value || !month.value || !year.value) return null;
      const { gy, gm, gd } = toGregorian(Number(year.value), Number(month.value), Number(day.value));
      return `${gy}-${pad2(gm)}-${pad2(gd)}`;
    },
    set(iso) {
      if (!iso) {
        if (optional) { year.value = ''; month.value = ''; fillDays(); return; }
        iso = todayISO();
      }
      const [gy, gm, gd] = iso.split('-').map(Number);
      const j = toJalali(gy, gm, gd);
      if (![...year.options].some((o) => o.value === String(j.jy))) year.append(el('option', { value: j.jy }, faPlain.format(j.jy)));
      year.value = String(j.jy); month.value = String(j.jm); fillDays(); day.value = String(j.jd);
    },
  };
  if (!optional) root._jd.set(todayISO());
}
for (const root of document.querySelectorAll('.jdate')) initJDate(root);
const getDate = (sel) => $(sel)._jd.get();
const setDate = (sel, v) => $(sel)._jd.set(v);

/* ---- Labels ---- */
const CATS = [5000, 10000, 20000, 40000, null];
const inCat = (t, c) => (c ? t.interval_km === c : !CATS.includes(t.interval_km));
const catLabel = (c) => (c ? `هر ${fmtNum(c)} کیلومتر` : 'کارهای سفارشی و بدون زمان‌بندی');
const ROLE_LABEL = { admin: 'مدیر', member: 'عضو' };

/* ---- Persian-only error messages ---- */
const hasPersian = (s) => /[؀-ۿ]/.test(s);
const ERROR_RULES = [
  ['invalid login credentials', 'ایمیل یا رمز عبور نادرست است.'],
  ['email not confirmed', 'ایمیل شما هنوز تأیید نشده است. لینک ارسال‌شده به ایمیل را باز کنید.'],
  ['user already registered', 'با این ایمیل قبلاً حساب ساخته شده است.'],
  ['signups not allowed', 'ساخت حساب جدید غیرفعال است. از مدیر بخواهید شما را دعوت کند.'],
  ['password should be', 'رمز عبور باید حداقل ۸ نویسه باشد.'],
  ['invalid email', 'نشانی ایمیل معتبر نیست.'],
  ['rate limit', 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.'],
  ['for security purposes', 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.'],
  ['failed to fetch', 'اتصال به اینترنت یا سرور برقرار نشد.'],
  ['networkerror', 'اتصال به اینترنت یا سرور برقرار نشد.'],
  ['load failed', 'اتصال به اینترنت یا سرور برقرار نشد.'],
  ['jwt', 'نشست شما منقضی شده است. دوباره وارد شوید.'],
  ['row-level security', 'شما اجازه انجام این کار را ندارید.'],
  ['permission denied', 'شما اجازه انجام این کار را ندارید.'],
  ['duplicate key', 'این مورد قبلاً ثبت شده است.'],
  ['check constraint', 'مقدار واردشده معتبر نیست.'],
];
function errText(e) {
  const raw = String((e && (e.message || e.error_description)) || e || '');
  if (hasPersian(raw)) return raw;
  const low = raw.toLowerCase();
  for (const [key, msg] of ERROR_RULES) if (low.includes(key)) return msg;
  return 'مشکلی پیش آمد. دوباره تلاش کنید.';
}

/* ---- UI feedback ---- */
let bannerTimer;
function banner(msg, kind = 'error') {
  const b = $('#banner');
  clearTimeout(bannerTimer);
  if (!msg) { b.hidden = true; return; }
  b.className = 'banner banner--' + kind;
  b.textContent = msg;
  b.hidden = false;
  if (kind === 'success') bannerTimer = setTimeout(() => { b.hidden = true; }, 4000);
}
function inlineError(id, msg) { const b = $(id); b.textContent = msg || ''; b.hidden = !msg; }

async function withBusy(button, busyText, fn) {
  const prev = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try { return await fn(); } finally { button.disabled = false; button.textContent = prev; }
}

// Persian confirmation dialog (instead of the browser's native confirm()).
function confirmDialog(message) {
  return new Promise((resolve) => {
    const d = $('#confirm-dialog');
    $('#confirm-text').textContent = message;
    const finish = (value) => {
      $('#confirm-yes').onclick = null; $('#confirm-no').onclick = null;
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
      resolve(value);
    };
    const onCancel = () => finish(false);
    d.addEventListener('cancel', onCancel);
    $('#confirm-yes').onclick = () => finish(true);
    $('#confirm-no').onclick = () => finish(false);
    d.showModal();
  });
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function show(view) {
  for (const id of ['auth-view', 'denied-view', 'app-view']) $('#' + id).hidden = id !== view;
  $('#header-actions').hidden = view !== 'app-view';
  $('#tabs').hidden = view !== 'app-view';
}

/* ================================================================== *
 * Supabase client
 * ================================================================== */
const configured = SUPABASE_URL && SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
if (!configured) {
  const box = $('#config-error');
  box.textContent = 'اتصال به Supabase تنظیم نشده است. فایل config.js را باز کنید و مقدار SUPABASE_URL و SUPABASE_ANON_KEY را وارد کنید (راهنما در فایل README.md).';
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
  $('#auth-toggle').textContent = up ? 'قبلاً حساب ساخته‌ام' : 'ساخت حساب جدید';
  $('#auth-sub').textContent = up
    ? 'حساب بسازید و ایمیل خود را تأیید کنید. فقط اعضای دعوت‌شده به اطلاعات دسترسی دارند.'
    : 'برای دیدن اطلاعات مشترک خانواده وارد شوید.';
  $('#auth-password').autocomplete = up ? 'new-password' : 'current-password';
  inlineError('#auth-error', '');
}
$('#auth-toggle').addEventListener('click', () => setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  banner('');
  inlineError('#auth-error', '');
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!EMAIL_RE.test(email)) return inlineError('#auth-error', 'نشانی ایمیل معتبر وارد کنید.');
  if (!password) return inlineError('#auth-error', 'رمز عبور را وارد کنید.');
  if (state.authMode === 'signup' && password.length < 8) return inlineError('#auth-error', 'رمز عبور باید حداقل ۸ نویسه باشد.');
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
          banner('حساب ساخته شد. ایمیل خود را بررسی کنید و لینک تأیید را باز کنید؛ سپس وارد شوید.', 'info');
          setAuthMode('signin');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      inlineError('#auth-error', errText(err));
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
  route();
  const ok = await loadAll(false);
  if (!ok) return;
  if (!state.member) { $('#denied-email').textContent = user.email || ''; show('denied-view'); return; }
  subscribe();
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
      teardownChannel();
      if (silent) {
        const { data } = await supabase.auth.getUser();
        $('#denied-email').textContent = data.user?.email || '';
        show('denied-view');
      }
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

// Visual status: done = green, upcoming = orange, overdue = red.
function displayStatus(info, task) {
  if (info.status === 'overdue') return { cls: 'overdue', label: 'عقب‌افتاده' };
  if (info.status === 'soon') return { cls: 'upcoming', label: 'نزدیک سررسید' };
  if (info.done) return { cls: 'done', label: 'انجام‌شده' };
  if (task.interval_km) return { cls: 'upcoming', label: 'پیش‌رو' };
  return { cls: 'none', label: 'ثبت نشده' };
}
const statusBadge = (s) => el('span', { class: 'badge badge--' + s.cls }, s.label);

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

const stat = (label, value, cls = '') => el('div', { class: 'stat ' + cls },
  el('span', { class: 'stat__label' }, label), el('span', { class: 'stat__value' }, value));

function renderDashboard() {
  const infos = state.tasks.map((t) => { const i = taskInfo(t); return { t, i, s: displayStatus(i, t) }; });
  const overdue = infos.filter((x) => x.s.cls === 'overdue');
  const pending = infos.filter((x) => x.s.cls === 'upcoming');
  const doneList = infos.filter((x) => x.s.cls === 'done' || (x.i.done && x.s.cls !== 'overdue'))
    .sort((a, b) => b.i.last.service_date.localeCompare(a.i.last.service_date));
  const upcoming = infos.filter((x) => x.t.interval_km && x.s.cls !== 'overdue')
    .sort((a, b) => a.i.remaining - b.i.remaining);
  const lv = lastVisit();

  const kmCard = el('div', { class: 'stat' },
    el('span', { class: 'stat__label' }, 'کیلومتر فعلی'),
    el('span', { class: 'stat__value' }, fmtKm(state.vehicle?.current_mileage)),
    el('button', { class: 'btn btn--sm', type: 'button', onclick: openKmDialog }, 'ثبت کیلومتر جدید'));
  $('#dash-vehicle').replaceChildren(
    stat('خودرو', state.vehicle?.name || '—', 'stat--vehicle'),
    kmCard,
    stat('تاریخ آخرین سرویس', lv ? fmtDate(lv.service_date) : 'ثبت نشده'),
    stat('کیلومتر آخرین سرویس', lv ? fmtKm(lv.mileage) : '—'));

  $('#dash-counts').replaceChildren(
    stat('عقب‌افتاده', fmtNum(overdue.length), 'stat--overdue'),
    stat('پیش‌رو', fmtNum(pending.length), 'stat--upcoming'),
    stat('انجام‌شده', fmtNum(doneList.length), 'stat--done'),
    stat('کل سرویس‌های ثبت‌شده', fmtNum(state.visits.length)));

  $('#dash-alerts').replaceChildren(...(overdue.length ? [el('div', { class: 'banner banner--error' },
    el('b', {}, `هشدار: ${fmtNum(overdue.length)} سرویس عقب‌افتاده است. `),
    overdue.map((x, k) => (k ? '، ' : '') + `${x.t.title} (${fmtKm(-x.i.remaining)} دیرتر از موعد)`).join(''))] : []));

  $('#dash-upcoming').replaceChildren(...(upcoming.length
    ? upcoming.slice(0, 8).map(({ t, i, s }) => el('div', { class: 'row-item' },
        el('div', { class: 'row-item__body' }, el('div', { class: 'row-item__title' }, t.title),
          el('div', { class: 'row-item__meta' }, `سررسید: ${fmtKm(i.nextDue)} · ${fmtKm(i.remaining)} مانده`)),
        statusBadge(s.cls === 'done' ? { cls: 'upcoming', label: 'پیش‌رو' } : s)))
    : [el('p', { class: 'empty' }, 'سرویس زمان‌بندی‌شده‌ای وجود ندارد.')]));

  $('#dash-completed').replaceChildren(...(doneList.length
    ? doneList.slice(0, 8).map(({ t, i }) => el('div', { class: 'row-item' },
        el('div', { class: 'row-item__body' }, el('div', { class: 'row-item__title' }, t.title),
          el('div', { class: 'row-item__meta' }, `${fmtDate(i.last.service_date)} · ${fmtKm(i.last.mileage)}`)),
        statusBadge({ cls: 'done', label: 'انجام‌شده' })))
    : [el('p', { class: 'empty' }, 'هنوز سرویسی ثبت نشده است.')]));

  $('#dash-recent').replaceChildren(...(state.visits.length
    ? state.visits.slice(0, 5).map(visitCard)
    : [el('p', { class: 'empty' }, 'هنوز هیچ سرویسی ثبت نشده است. از بخش «تاریخچه سرویس» اولین مورد را ثبت کنید.')]));
}

function renderChecklist() {
  const groups = CATS.map((c) => ({ c, items: state.tasks.filter((t) => inCat(t, c)) })).filter((g) => g.items.length);
  $('#checklist-body').replaceChildren(...groups.map(({ c, items }) => el('div', { class: 'stack--sm' },
    el('h3', { class: 'group-title' }, catLabel(c)),
    el('div', { class: 'card card--flush' }, items.map(taskRow)))));
}

function taskRow(task) {
  const info = taskInfo(task);
  const s = displayStatus(info, task);
  const { last } = info;
  const lastNote = last?.visit_notes.length ? last.visit_notes[last.visit_notes.length - 1].body : '';
  const box = el('input', {
    type: 'checkbox', class: 'checkbox-lg', 'aria-label': task.title, checked: info.done,
    onclick: (e) => {
      e.preventDefault(); // the tick changes only after the database confirms the change
      if (info.done && last) openVisitDialog(last);
      else openQuickDialog(task);
    },
  });
  return el('div', { class: 'row-item' }, box,
    el('div', { class: 'row-item__body' },
      el('div', { class: 'row-item__title' }, task.title, statusBadge(s)),
      el('div', { class: 'row-item__meta' }, last
        ? `آخرین انجام: ${fmtDate(last.service_date)} · ${fmtKm(last.mileage)} · ثبت‌کننده: ${person(last.created_by)}`
        : 'تاکنون ثبت نشده است'),
      task.interval_km && el('div', { class: 'row-item__meta' + (info.remaining <= 0 ? ' row-item__meta--overdue' : '') },
        `سررسید بعدی: ${fmtKm(info.nextDue)}` + (info.remaining > 0 ? ` (${fmtKm(info.remaining)} مانده)` : ` (${fmtKm(-info.remaining)} دیرتر از موعد)`)),
      lastNote && el('div', { class: 'row-item__meta' }, 'یادداشت: ' + (lastNote.length > 140 ? lastNote.slice(0, 140) + '…' : lastNote))));
}

function visitCard(v) {
  const tasks = v.visit_tasks.map((x) => taskById(x.task_id)).filter(Boolean);
  return el('article', { class: 'card visit' },
    el('div', { class: 'visit__head' },
      el('span', { class: 'visit__date' }, fmtDate(v.service_date) + ' · ' + fmtKm(v.mileage)),
      el('button', { class: 'btn btn--sm', type: 'button', onclick: () => openVisitDialog(v) }, 'ویرایش و افزودن یادداشت')),
    el('div', { class: 'visit__meta' },
      v.shop_name && el('span', {}, 'تعمیرگاه: ' + v.shop_name),
      v.total_cost != null && el('span', {}, 'هزینه: ' + fmtNum(Number(v.total_cost)) + ' تومان'),
      el('span', {}, 'ثبت‌کننده: ' + person(v.created_by)),
      v.updated_by && v.updated_by !== v.created_by && el('span', {}, 'آخرین ویرایش: ' + person(v.updated_by))),
    tasks.length ? el('div', { class: 'chips' }, tasks.map((t) => el('span', { class: 'chip' }, t.title))) : null,
    v.parts_replaced && el('div', {}, el('span', { class: 'muted' }, 'قطعات تعویض‌شده: '), v.parts_replaced),
    v.visit_notes.length ? el('div', { class: 'notes' }, v.visit_notes.map((n) => el('div', { class: 'note' }, n.body,
      el('span', { class: 'note__by' }, `${person(n.created_by)} · ${fmtDateTime(n.created_at)}`)))) : null);
}

/* ---- History filters ---- */
function filteredVisits() {
  const q = $('#h-search').value.trim().toLowerCase();
  const from = getDate('#h-from'), to = getDate('#h-to');
  const kmMin = parseIntField($('#h-kmmin').value), kmMax = parseIntField($('#h-kmmax').value);
  const cat = $('#h-cat').value;
  return state.visits.filter((v) => {
    if (from && v.service_date < from) return false;
    if (to && v.service_date > to) return false;
    if (!Number.isNaN(kmMin) && v.mileage < kmMin) return false;
    if (!Number.isNaN(kmMax) && v.mileage > kmMax) return false;
    const tasks = v.visit_tasks.map((x) => taskById(x.task_id)).filter(Boolean);
    if (cat && !tasks.some((t) => (cat === 'custom' ? inCat(t, null) : t.interval_km === Number(cat)))) return false;
    if (q) {
      const hay = [v.shop_name, v.parts_replaced, person(v.created_by), ...v.visit_notes.map((n) => n.body), ...tasks.map((t) => t.title)]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q) && !hay.includes(toAscii(q))) return false;
    }
    return true;
  });
}

function renderHistory() {
  const rows = filteredVisits();
  $('#h-count').textContent = `${fmtNum(rows.length)} مورد از ${fmtNum(state.visits.length)} سرویس`;
  $('#history-list').replaceChildren(...(rows.length ? rows.map(visitCard)
    : [el('p', { class: 'empty' }, state.visits.length ? 'موردی با این فیلترها پیدا نشد.' : 'هنوز هیچ سرویسی ثبت نشده است.')]));
}
for (const id of ['#h-search', '#h-kmmin', '#h-kmmax', '#h-cat']) $(id).addEventListener('input', renderHistory);
for (const id of ['#h-from', '#h-to']) $(id).addEventListener('change', renderHistory);
$('#h-reset').addEventListener('click', () => {
  for (const id of ['#h-search', '#h-kmmin', '#h-kmmax']) $(id).value = '';
  setDate('#h-from', ''); setDate('#h-to', '');
  $('#h-cat').value = '';
  renderHistory();
});

/* ---- CSV export (opens in Excel) ---- */
function csvCell(v, text = true) {
  let s = String(v ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
  return '"' + s.replace(/"/g, '""') + '"';
}
$('#btn-export').addEventListener('click', () => {
  const rows = filteredVisits();
  if (!rows.length) { banner('موردی برای خروجی گرفتن وجود ندارد.', 'info'); return; }
  const head = ['تاریخ میلادی', 'تاریخ شمسی', 'کیلومتر', 'تعمیرگاه', 'کارهای انجام‌شده', 'قطعات تعویض‌شده', 'هزینه کل (تومان)', 'یادداشت‌ها', 'ثبت‌کننده'];
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
  const a = el('a', { href: URL.createObjectURL(blob), download: 'تاریخچه-سرویس-پراید.csv' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  banner('فایل خروجی آماده شد.', 'success');
});

/* ================================================================== *
 * Dialog: service visit (create / edit / add notes)
 * ================================================================== */
function openVisitDialog(visit = null) {
  state.editingVisitId = visit ? visit.id : null;
  $('#visit-title').textContent = visit ? 'ویرایش سرویس و افزودن یادداشت' : 'ثبت سرویس جدید';
  inlineError('#visit-error', '');
  setDate('#v-date', visit?.service_date ?? todayISO());
  setNum($('#v-km'), visit ? visit.mileage : (currentKm() || ''));
  $('#v-shop').value = visit?.shop_name ?? '';
  setNum($('#v-cost'), visit?.total_cost != null ? Number(visit.total_cost) : '');
  $('#v-parts').value = visit?.parts_replaced ?? '';
  $('#v-note').value = '';
  $('#v-note-label').textContent = visit ? 'افزودن یادداشت جدید (یادداشت‌های قبلی حفظ می‌شوند)' : 'یادداشت';

  const selected = new Set(visit ? visit.visit_tasks.map((x) => x.task_id) : []);
  $('#v-tasks').replaceChildren(...CATS.flatMap((c) => {
    const items = state.tasks.filter((t) => inCat(t, c));
    if (!items.length) return [];
    return [el('div', { class: 'picklist__group' }, catLabel(c)),
      ...items.map((t) => el('label', { class: 'check' },
        el('input', { type: 'checkbox', class: 'check__box', value: t.id, checked: selected.has(t.id) }), t.title))];
  }));

  const old = visit?.visit_notes ?? [];
  $('#v-oldnotes-wrap').hidden = !old.length;
  $('#v-oldnotes').replaceChildren(...old.map((n) => el('div', { class: 'note' }, n.body,
    el('span', { class: 'note__by' }, `${person(n.created_by)} · ${fmtDateTime(n.created_at)}`))));
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
  const date = getDate('#v-date');
  const km = parseIntField($('#v-km').value);
  const cost = parseMoney($('#v-cost').value);
  if (!date) return inlineError('#visit-error', 'تاریخ سرویس را کامل انتخاب کنید.');
  if (Number.isNaN(km)) return inlineError('#visit-error', 'کیلومتر خودرو را با عدد وارد کنید.');
  if (Number.isNaN(cost)) return inlineError('#visit-error', 'هزینه را فقط با عدد وارد کنید.');
  if (!state.vehicle) return inlineError('#visit-error', 'خودرویی در پایگاه داده پیدا نشد. فایل schema.sql را اجرا کنید.');
  const taskIds = [...$('#v-tasks').querySelectorAll('input:checked')].map((i) => i.value);
  const editing = !!state.editingVisitId;
  await withBusy($('#visit-save'), 'در حال ذخیره…', async () => {
    try {
      await saveVisit({
        id: state.editingVisitId, date, km, shop: $('#v-shop').value, parts: $('#v-parts').value,
        cost, taskIds, note: $('#v-note').value,
      });
      $('#visit-dialog').close();
      banner(editing ? 'تغییرات سرویس ذخیره شد.' : 'سرویس جدید ثبت شد.', 'success');
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
  setDate('#q-date', todayISO());
  setNum($('#q-km'), currentKm() || '');
  $('#q-shop').value = '';
  $('#q-note').value = '';
  $('#quick-dialog').showModal();
}
$('#quick-cancel').addEventListener('click', () => $('#quick-dialog').close());
$('#quick-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#quick-error', '');
  const date = getDate('#q-date');
  const km = parseIntField($('#q-km').value);
  if (!date) return inlineError('#quick-error', 'تاریخ انجام را کامل انتخاب کنید.');
  if (Number.isNaN(km)) return inlineError('#quick-error', 'کیلومتر خودرو را با عدد وارد کنید.');
  if (!state.vehicle) return inlineError('#quick-error', 'خودرویی در پایگاه داده پیدا نشد.');
  await withBusy($('#quick-save'), 'در حال ثبت…', async () => {
    try {
      await saveVisit({
        id: null, date, km, shop: $('#q-shop').value, parts: null, cost: null,
        taskIds: [state.quickTask.id], note: $('#q-note').value,
      });
      $('#quick-dialog').close();
      banner('انجام سرویس ثبت شد.', 'success');
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
  const title = $('#t-title').value.trim();
  const raw = $('#t-km').value.trim();
  const km = raw === '' ? null : parseIntField(raw);
  if (!title) return inlineError('#task-error', 'عنوان کار را وارد کنید.');
  if (km !== null && (Number.isNaN(km) || km <= 0)) return inlineError('#task-error', 'کیلومتر تکرار باید یک عدد مثبت باشد.');
  await withBusy($('#task-save'), 'در حال افزودن…', async () => {
    try {
      const { error } = await supabase.from('maintenance_tasks')
        .insert({ title, interval_km: km, is_custom: true, sort_order: 1000 });
      if (error) throw error.code === '23505' ? new Error('این کار قبلاً در فهرست وجود دارد.') : error;
      await loadAll(true);
      $('#task-dialog').close();
      banner('کار سفارشی به چک‌لیست اضافه شد.', 'success');
    } catch (err) {
      inlineError('#task-error', 'افزوده نشد: ' + errText(err));
    }
  });
});

/* ---- Current mileage ---- */
function openKmDialog() {
  inlineError('#km-error', '');
  setNum($('#k-km'), currentKm() || '');
  $('#km-dialog').showModal();
}
$('#km-cancel').addEventListener('click', () => $('#km-dialog').close());
$('#km-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#km-error', '');
  const km = parseIntField($('#k-km').value);
  if (Number.isNaN(km)) return inlineError('#km-error', 'کیلومتر را با عدد وارد کنید.');
  if (!state.vehicle) return inlineError('#km-error', 'خودرویی در پایگاه داده پیدا نشد.');
  await withBusy($('#km-save'), 'در حال ذخیره…', async () => {
    try {
      const { error } = await supabase.from('vehicles').update({ current_mileage: km }).eq('id', state.vehicle.id);
      if (error) throw error;
      await loadAll(true);
      $('#km-dialog').close();
      banner('کیلومتر فعلی ذخیره شد.', 'success');
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
      el('td', {}, el('span', { class: 'ltr muted' }, m.email)),
      el('td', {}, el('select', {
        class: 'control', 'aria-label': 'نقش',
        onchange: async (ev) => {
          inlineError('#members-error', '');
          const { error: err } = await supabase.from('family_members').update({ role: ev.target.value }).eq('user_id', m.user_id);
          if (err) { inlineError('#members-error', errText(err)); loadMembers(); }
        },
      }, el('option', { value: 'member', selected: m.role === 'member' }, 'عضو'),
         el('option', { value: 'admin', selected: m.role === 'admin' }, 'مدیر'))),
      el('td', {}, m.user_id === state.userId ? el('span', { class: 'muted' }, 'شما') : el('button', {
        class: 'btn btn--sm btn--danger', type: 'button',
        onclick: async () => {
          if (!(await confirmDialog(`«${m.display_name || m.email}» از فهرست خانواده حذف شود؟ سوابق ثبت‌شده توسط او باقی می‌ماند.`))) return;
          inlineError('#members-error', '');
          const { error: err } = await supabase.from('family_members').delete().eq('user_id', m.user_id);
          if (err) inlineError('#members-error', errText(err)); else loadMembers();
        },
      }, 'حذف'))));
    const inviteRows = invites.map((i) => el('tr', {},
      el('td', { colspan: 2 }, el('span', { class: 'ltr muted' }, i.email)),
      el('td', {}, ROLE_LABEL[i.role] + ' (دعوت‌شده)'),
      el('td', {}, el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: async () => {
          const { error: err } = await supabase.from('family_invites').delete().eq('email', i.email);
          if (err) inlineError('#members-error', errText(err)); else loadMembers();
        },
      }, 'لغو دعوت'))));
    body.className = '';
    body.replaceChildren(el('table', { class: 'table' }, el('tbody', {}, rows, inviteRows)));
  } catch (err) {
    body.className = 'empty';
    body.textContent = 'خطا در دریافت اعضا: ' + errText(err);
  }
}
$('#btn-members').addEventListener('click', () => {
  inlineError('#members-error', '');
  $('#members-body').className = 'loading';
  $('#members-body').textContent = 'در حال دریافت…';
  $('#members-dialog').showModal();
  loadMembers();
});
$('#members-close').addEventListener('click', () => $('#members-dialog').close());
$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  inlineError('#members-error', '');
  const email = $('#invite-email').value.trim();
  if (!EMAIL_RE.test(email)) return inlineError('#members-error', 'نشانی ایمیل معتبر وارد کنید.');
  await withBusy($('#invite-submit'), 'در حال دعوت…', async () => {
    const { data, error } = await supabase.rpc('invite_member', { p_email: email, p_role: $('#invite-role').value });
    if (error) { inlineError('#members-error', errText(error)); return; }
    $('#invite-email').value = '';
    banner(data === 'invited'
      ? 'دعوت ثبت شد. او باید با همین ایمیل حساب بسازد و ایمیلش را تأیید کند؛ سپس خودکار دسترسی می‌گیرد.'
      : 'این فرد قبلاً حساب داشت و اکنون عضو خانواده شد.', data === 'invited' ? 'info' : 'success');
    loadMembers();
  });
});

/* ================================================================== *
 * Realtime sync
 * ================================================================== */
function setSync(kind, text) { const s = $('#sync'); s.className = 'sync' + (kind ? ' sync--' + kind : ''); s.textContent = text; }

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
      setSync('off', 'آفلاین، در حال تلاش مجدد…');
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
  const view = ['dashboard', 'checklist', 'history'].includes(v) ? v : 'dashboard';
  for (const name of ['dashboard', 'checklist', 'history']) $('#view-' + name).hidden = name !== view;
  for (const a of document.querySelectorAll('.tabs__link')) a.classList.toggle('is-active', a.dataset.view === view);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ================================================================== *
 * Start
 * ================================================================== */
setAuthMode('signin');
show('auth-view'); // replaced by onAuthStateChange once the saved session (if any) is restored
