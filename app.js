import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, CURRENCY } from './config.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);

// Safe DOM builder: strings become text nodes, so user data is never parsed as HTML.
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
};

const LABELS = {
  planned: 'Planned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled',
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
  general: 'General', home: 'Home', vehicle: 'Vehicle', appliance: 'Appliance', garden: 'Garden',
  electrical: 'Electrical', plumbing: 'Plumbing', hvac: 'Heating / cooling', other: 'Other',
};
const label = (v) => LABELS[v] || v;

const todayISO = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const money = (n) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY }).format(n); }
  catch { return String(n); }
};
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString() : '');

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

const errText = (e) => (e && (e.message || e.error_description)) || 'Something went wrong. Please try again.';

async function withBusy(button, fn) {
  const prev = button.textContent;
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; button.textContent = prev; }
}

/* ------------------------------------------------------------------ *
 * Configuration check
 * ------------------------------------------------------------------ */
const configured = SUPABASE_URL && SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR-ANON');

if (!configured) {
  const box = $('#config-error');
  box.textContent = 'Supabase is not configured. Open config.js and set SUPABASE_URL and SUPABASE_ANON_KEY (see README.md).';
  box.hidden = false;
  throw new Error('Supabase not configured');
}

// The anon key is public by design. Never put the service_role key in this file.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  userId: null,
  member: null,
  records: new Map(),   // id -> row (in-memory view of the cloud data only)
  channel: null,
  hasSubscribed: false,
  authMode: 'signin',
  editingId: null,
  names: new Map(),     // user_id -> display_name (for "added by")
};

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
function setAuthMode(mode) {
  state.authMode = mode;
  const up = mode === 'signup';
  $('#name-wrap').hidden = !up;
  $('#auth-submit').textContent = up ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = up ? 'I have an account' : 'Create account';
  $('#auth-sub').textContent = up
    ? 'Create an account, then confirm your email. Only invited family members get access.'
    : "Sign in to your family's shared records.";
  $('#auth-password').autocomplete = up ? 'new-password' : 'current-password';
}

$('#auth-toggle').addEventListener('click', () => setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  banner('');
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  await withBusy($('#auth-submit'), async () => {
    $('#auth-submit').textContent = 'Please wait…';
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
          banner('Account created. Check your email and click the confirmation link, then sign in.', 'info');
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
$('#denied-retry').addEventListener('click', () => withBusy($('#denied-retry'), async () => {
  const { data } = await supabase.auth.getSession();
  state.userId = null;
  await handleSession(data.session);
}));

// NOTE: do not await Supabase calls directly inside this callback (deadlock risk);
// defer with setTimeout.
supabase.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => handleSession(session), 0);
});

async function handleSession(session) {
  if (!session) {
    teardown();
    state.userId = null;
    state.member = null;
    show('auth-view');
    return;
  }
  if (state.userId === session.user.id && state.member) return; // token refresh etc.
  state.userId = session.user.id;
  await bootstrap(session.user);
}

/* ------------------------------------------------------------------ *
 * Bootstrap after sign-in
 * ------------------------------------------------------------------ */
async function bootstrap(user) {
  banner('');
  try {
    const { data: member, error } = await supabase
      .from('family_members').select('*').eq('user_id', user.id).maybeSingle();
    if (error) throw error;

    if (!member) {
      state.member = null;
      $('#denied-email').textContent = user.email || '';
      show('denied-view');
      return;
    }

    state.member = member;
    $('#who').textContent = `${member.display_name || member.email} (${member.role})`;
    $('#btn-members').hidden = member.role !== 'admin';
    show('app-view');
    await loadRecords();
    subscribe();
  } catch (err) {
    state.member = null;
    show('auth-view');
    banner('Could not load your account: ' + errText(err));
  }
}

/* ------------------------------------------------------------------ *
 * Data: load / create / update / delete  (all go straight to Supabase)
 * ------------------------------------------------------------------ */
async function loadRecords() {
  $('#loading').hidden = false;
  try {
    const [{ data: rows, error }, { data: people, error: e2 }] = await Promise.all([
      supabase.from('maintenance_records').select('*').order('created_at', { ascending: false }),
      supabase.from('family_members').select('user_id, display_name, email'),
    ]);
    if (error) throw error;
    if (e2) throw e2;
    state.records = new Map(rows.map((r) => [r.id, r]));
    state.names = new Map(people.map((p) => [p.user_id, p.display_name || p.email]));
    render();
  } catch (err) {
    banner('Could not load records: ' + errText(err));
  } finally {
    $('#loading').hidden = true;
  }
}

function collectForm() {
  const v = (id) => $(id).value.trim();
  const status = $('#f-status').value;
  let done = $('#f-done').value || null;
  if (status === 'completed' && !done) done = todayISO();
  if (status !== 'completed') done = null;
  return {
    title: v('#f-title'),
    asset: v('#f-asset') || null,
    category: $('#f-category').value,
    status,
    priority: $('#f-priority').value,
    due_date: $('#f-due').value || null,
    completed_on: done,
    cost: $('#f-cost').value === '' ? null : Number($('#f-cost').value),
    performed_by: v('#f-by') || null,
    description: v('#f-desc') || null,
  };
}

async function saveRecord(payload) {
  const q = state.editingId
    ? supabase.from('maintenance_records').update(payload).eq('id', state.editingId)
    : supabase.from('maintenance_records').insert(payload);
  const { data, error } = await q.select().single();
  if (error) throw error;
  state.records.set(data.id, data); // realtime will deliver the same row; idempotent
  render();
}

async function deleteRecord(id) {
  const { error } = await supabase.from('maintenance_records').delete().eq('id', id);
  if (error) throw error;
  state.records.delete(id);
  render();
}

/* ------------------------------------------------------------------ *
 * Realtime
 * ------------------------------------------------------------------ */
function setSync(kind, text) {
  const s = $('#sync');
  s.className = 'sync ' + kind;
  s.textContent = text;
}

function subscribe() {
  teardown();
  setSync('', 'Connecting…');
  state.channel = supabase
    .channel('family-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'maintenance_records' }, (p) => {
      if (p.eventType === 'DELETE') state.records.delete(p.old.id);
      else state.records.set(p.new.id, p.new);
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_members' }, async () => {
      // Membership changed: re-verify our own access and refresh names/member list.
      const { data } = await supabase.from('family_members').select('*').eq('user_id', state.userId).maybeSingle();
      if (!data) { state.userId = null; const s = await supabase.auth.getSession(); handleSession(s.data.session); return; }
      state.member = data;
      $('#btn-members').hidden = data.role !== 'admin';
      const { data: people } = await supabase.from('family_members').select('user_id, display_name, email');
      if (people) state.names = new Map(people.map((x) => [x.user_id, x.display_name || x.email]));
      if ($('#members-dialog').open) loadMembers();
      render();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setSync('live', 'Live');
        if (state.hasSubscribed) loadRecords(); // we were offline: catch up
        state.hasSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setSync('off', 'Offline – reconnecting…');
      }
    });
}

function teardown() {
  if (state.channel) { supabase.removeChannel(state.channel); state.channel = null; }
  state.hasSubscribed = false;
  state.records = new Map();
  $('#list').replaceChildren();
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  const f = $('#filter-status').value;
  return [...state.records.values()]
    .filter((r) => {
      if (f === 'open') return r.status === 'planned' || r.status === 'in_progress';
      return !f || r.status === f;
    })
    .filter((r) => !q || [r.title, r.asset, r.description, r.performed_by, r.category]
      .some((x) => x && x.toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function renderStats() {
  const all = [...state.records.values()];
  const open = all.filter((r) => r.status === 'planned' || r.status === 'in_progress');
  const overdue = open.filter((r) => r.due_date && r.due_date < todayISO());
  const spent = all.filter((r) => r.status === 'completed').reduce((s, r) => s + Number(r.cost || 0), 0);
  const stat = (n, t, cls) => el('div', { class: 'card stat' }, el('b', { class: cls }, String(n)), el('span', {}, t));
  $('#stats').replaceChildren(
    stat(all.length, 'Total records'),
    stat(open.length, 'Open'),
    stat(overdue.length, 'Overdue', overdue.length ? 'overdue' : ''),
    stat(money(spent), 'Spent (completed)'),
  );
}

function recordCard(r) {
  const overdue = (r.status === 'planned' || r.status === 'in_progress') && r.due_date && r.due_date < todayISO();
  const meta = [
    r.asset && el('span', {}, '🔧 ' + r.asset),
    el('span', {}, label(r.category)),
    r.due_date && el('span', { class: overdue ? 'overdue' : '' }, 'Due ' + fmtDate(r.due_date) + (overdue ? ' (overdue)' : '')),
    r.completed_on && el('span', {}, 'Done ' + fmtDate(r.completed_on)),
    r.cost != null && el('span', {}, money(r.cost)),
    r.performed_by && el('span', {}, 'By ' + r.performed_by),
    el('span', {}, 'Added by ' + (state.names.get(r.created_by) || 'a family member')),
  ];
  const isAdmin = state.member?.role === 'admin';
  const canDelete = isAdmin || r.created_by === state.userId;
  return el('article', { class: 'card record' },
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h3', {}, r.title),
      el('div', { class: 'row' },
        el('span', { class: 'pill ' + r.status }, label(r.status)),
        el('span', { class: 'pill ' + r.priority }, label(r.priority)))),
    el('div', { class: 'meta' }, meta),
    r.description && el('div', { style: 'white-space:pre-wrap' }, r.description),
    el('div', { class: 'row' },
      el('button', { onclick: () => openRecordDialog(r) }, 'Edit'),
      canDelete && el('button', {
        class: 'danger',
        onclick: async (e) => {
          if (!confirm(`Delete "${r.title}" for everyone in the family?`)) return;
          banner('');
          await withBusy(e.currentTarget, async () => {
            e.currentTarget.textContent = 'Deleting…';
            try { await deleteRecord(r.id); } catch (err) { banner('Delete failed: ' + errText(err)); }
          });
        },
      }, 'Delete')));
}

function render() {
  if (!state.member) return;
  renderStats();
  const rows = filtered();
  $('#list').replaceChildren(...(rows.length
    ? rows.map(recordCard)
    : [el('p', { class: 'muted', style: 'text-align:center;padding:30px' },
        state.records.size ? 'No records match your filters.' : 'No records yet. Add the first one!')]));
}

$('#search').addEventListener('input', render);
$('#filter-status').addEventListener('change', render);

/* ------------------------------------------------------------------ *
 * Record dialog
 * ------------------------------------------------------------------ */
function openRecordDialog(r = null) {
  state.editingId = r ? r.id : null;
  $('#record-title').textContent = r ? 'Edit record' : 'New record';
  $('#record-error').hidden = true;
  $('#f-title').value = r?.title ?? '';
  $('#f-asset').value = r?.asset ?? '';
  $('#f-category').value = r?.category ?? 'general';
  $('#f-status').value = r?.status ?? 'planned';
  $('#f-priority').value = r?.priority ?? 'medium';
  $('#f-due').value = r?.due_date ?? '';
  $('#f-done').value = r?.completed_on ?? '';
  $('#f-cost').value = r?.cost ?? '';
  $('#f-by').value = r?.performed_by ?? '';
  $('#f-desc').value = r?.description ?? '';
  $('#record-dialog').showModal();
}

$('#btn-add').addEventListener('click', () => openRecordDialog());
$('#record-cancel').addEventListener('click', () => $('#record-dialog').close());

$('#record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#record-error').hidden = true;
  await withBusy($('#record-save'), async () => {
    $('#record-save').textContent = 'Saving…';
    try {
      await saveRecord(collectForm());
      $('#record-dialog').close();
    } catch (err) {
      $('#record-error').textContent = 'Could not save: ' + errText(err);
      $('#record-error').hidden = false;
    }
  });
});

/* ------------------------------------------------------------------ *
 * Members dialog (admins only; enforced by RLS on the server)
 * ------------------------------------------------------------------ */
function membersError(msg) {
  const b = $('#members-error');
  b.textContent = msg || '';
  b.hidden = !msg;
}

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
      el('td', { class: 'muted' }, m.email),
      el('td', {}, el('select', {
        onchange: async (ev) => {
          membersError('');
          const { error: err } = await supabase.from('family_members').update({ role: ev.target.value }).eq('user_id', m.user_id);
          if (err) { membersError(errText(err)); loadMembers(); }
        },
      },
        el('option', { value: 'member', selected: m.role === 'member' }, 'Member'),
        el('option', { value: 'admin', selected: m.role === 'admin' }, 'Admin'))),
      el('td', {}, m.user_id === state.userId ? el('span', { class: 'muted' }, 'you') : el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Remove ${m.email} from the family?`)) return;
          membersError('');
          const { error: err } = await supabase.from('family_members').delete().eq('user_id', m.user_id);
          if (err) membersError(errText(err)); else loadMembers();
        },
      }, 'Remove'))));

    const inviteRows = invites.map((i) => el('tr', {},
      el('td', { colspan: 2 }, i.email, el('span', { class: 'muted' }, ' (pending invite)')),
      el('td', {}, label(i.role === 'admin' ? 'Admin' : 'Member')),
      el('td', {}, el('button', {
        onclick: async () => {
          const { error: err } = await supabase.from('family_invites').delete().eq('email', i.email);
          if (err) membersError(errText(err)); else loadMembers();
        },
      }, 'Cancel'))));

    body.className = '';
    body.replaceChildren(el('table', { class: 'simple' }, el('tbody', {}, rows, inviteRows)));
  } catch (err) {
    body.className = '';
    body.textContent = 'Could not load members: ' + errText(err);
  }
}

$('#btn-members').addEventListener('click', () => {
  membersError('');
  $('#members-body').className = 'spinner';
  $('#members-body').textContent = 'Loading…';
  $('#members-dialog').showModal();
  loadMembers();
});
$('#members-close').addEventListener('click', () => $('#members-dialog').close());

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  membersError('');
  await withBusy($('#invite-submit'), async () => {
    $('#invite-submit').textContent = 'Inviting…';
    const { data, error } = await supabase.rpc('invite_member', {
      p_email: $('#invite-email').value,
      p_role: $('#invite-role').value,
    });
    if (error) { membersError(errText(error)); return; }
    $('#invite-email').value = '';
    if (data === 'invited') {
      membersError('');
      banner('Invite saved. Ask them to create an account with that email and confirm it — they will get access automatically.', 'info');
    }
    loadMembers();
  });
});

/* ------------------------------------------------------------------ *
 * Start: restore the auth session (token only) and route
 * ------------------------------------------------------------------ */
setAuthMode('signin');
show('auth-view');
