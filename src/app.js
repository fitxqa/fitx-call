// FitX Call — app shell (free Firebase "Spark" plan: no Cloud Functions, no server push)
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, getAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from 'firebase/auth';
import {
  initializeFirestore, writeBatch, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { CallSession } from './call.js';

const CFG = window.FITX_CONFIG || {};
const $ = (id) => document.getElementById(id);
const native = Capacitor.isNativePlatform();
const Native = registerPlugin('AudioRoute');
const VERSION = '1.1';

// ---------- UI helpers ----------
const screens = ['s-loading', 's-setup', 's-login', 's-main', 's-incoming', 's-call'];
function show(id) { screens.forEach((s) => $(s).classList.toggle('hidden', s !== id)); }
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : typeof ts === 'number' ? ts : 0);
function ago(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
const fmtDur = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const saverOn = () => { try { return localStorage.getItem('saver') === '1'; } catch (e) { return false; } };
$('ver').textContent = `FitX Call v${VERSION}`;

// ---------- Tones (generated, no audio files) ----------
const Tone = {
  ctx: null, timer: null,
  _beep(freqs, dur, vol = 0.18) {
    const ctx = this.ctx || (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
    const g = ctx.createGain(); g.gain.value = vol; g.connect(ctx.destination);
    freqs.forEach((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g); o.start(); o.stop(ctx.currentTime + dur); });
  },
  ring() { this.stop(); const play = () => { this._beep([880, 1100], 0.35, 0.22); setTimeout(() => this._beep([880, 1100], 0.35, 0.22), 450); if (navigator.vibrate) navigator.vibrate([400, 200, 400]); }; play(); this.timer = setInterval(play, 2200); },
  ringback() { this.stop(); const play = () => this._beep([425], 1.0, 0.08); play(); this.timer = setInterval(play, 4000); },
  stop() { clearInterval(this.timer); this.timer = null; if (navigator.vibrate) navigator.vibrate(0); },
};

// ---------- Firebase ----------
const configured = CFG.firebase && CFG.firebase.apiKey && !String(CFG.firebase.apiKey).startsWith('PASTE');
let fb, auth, db, DBID = '(default)';
if (configured) {
  fb = initializeApp(CFG.firebase);
  auth = initializeAuth(fb, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  // Long-polling is the most reliable connection mode inside Android WebViews and on strict mobile networks.
}
// Pick the first Firestore database that exists: "(default)", else "default".
async function pickDatabase() {
  const ids = CFG.databaseIds || ['(default)'];
  for (const id of ids) {
    try {
      const r = await withTimeout(fetch(`https://firestore.googleapis.com/v1/projects/${CFG.firebase.projectId}/databases/${encodeURIComponent(id)}/documents/config/setup?key=${CFG.firebase.apiKey}`), 8000, 'net');
      if (r.status === 404) {
        let m = ''; try { m = JSON.stringify(await r.json()); } catch (e) {}
        if (/does not exist/i.test(m)) continue;
      }
      return id;
    } catch (e) { return ids[0]; }
  }
  return ids[0];
}
const DOMAIN = CFG.loginDomain || 'fitxcall.local';
const withTimeout = (p, ms, code) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code }), ms))]);
// Ask Google directly why the database can't be reached (the SDK only says "offline").
async function diagnoseDb() {
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${CFG.firebase.projectId}/databases/${encodeURIComponent(DBID)}/documents/config/setup?key=${CFG.firebase.apiKey}`;
    const r = await withTimeout(fetch(url), 10000, 'net');
    let msg = '';
    try { const j = await r.json(); msg = (j.error && (j.error.message || j.error.status)) || ''; } catch (e) {}
    if (r.ok) return 'DB OK (200)';
    if (r.status === 404 && /does not exist/i.test(msg)) return `No Firestore database found (tried ${(CFG.databaseIds || ['(default)']).join(' and ')})`;
    if (r.status === 404) return 'DB reachable (404 = setup not done yet)';
    return `DB error ${r.status}: ${msg.slice(0, 160)}`;
  } catch (e) { return 'Phone cannot reach Google servers (internet / VPN / firewall)'; }
}
const cleanUser = (u) => String(u || '').trim().toLowerCase();

// A second Firebase instance so the admin can create accounts without being signed out.
let creatorAuth = null;
function creator() {
  if (!creatorAuth) creatorAuth = initializeAuth(initializeApp(CFG.firebase, 'creator'), { persistence: inMemoryPersistence });
  return creatorAuth;
}

// ---------- State ----------
let me = null;
let users = [];
let current = null;
let incoming = null;
let pendingLink = null;
let unsubs = [];
let heartbeat = null;
let callTimer = null;
let inBackground = false;

// ---------- Auth ----------
async function emailFor(username) {
  try {
    const m = await withTimeout(getDoc(doc(db, 'usernames', username)), 8000, 'db-timeout');
    if (m.exists() && m.data().email) return m.data().email;
  } catch (e) { /* rules not published yet → fall back */ }
  return `${username}@${DOMAIN}`;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const u = cleanUser($('login-user').value);
    $('login-err').textContent = 'Connecting…';
    const email = await emailFor(u);
    $('login-err').textContent = 'Checking password…';
    await withTimeout(signInWithEmailAndPassword(auth, email, $('login-pass').value), 20000, 'timeout');
    $('login-err').textContent = 'Loading your account…';
  } catch (err) {
    const c = err.code || String(err.message || '');
    $('login-err').textContent = (c.includes('invalid') || c.includes('wrong') || c.includes('not-found')
      ? 'Wrong username or password' : c.includes('disabled') ? 'This account is disabled — contact admin'
        : c.includes('network') ? 'No internet connection'
          : c.includes('operation-not-allowed') ? 'Sign-in is not switched on in Firebase yet (Email/Password)'
            : c === 'timeout' ? 'Login server not responding — check internet and try again'
              : c.includes('api-key') || c.includes('app-not-authorized') ? 'Firebase API key problem — tell the developer'
                : 'Sign-in failed') + (c ? ` (${c.replace('auth/', '')})` : '');
  }
  btn.disabled = false; btn.textContent = 'Sign in';
});

$('logout').addEventListener('click', async () => {
  if (!confirm('Sign out? You will not receive calls on this phone.')) return;
  if (native) Native.stopService().catch(() => {});
  await signOut(auth);
});

$('change-pass').addEventListener('click', async () => {
  const cur = prompt('Current password:'); if (!cur) return;
  const np = prompt('New password (6+ characters):'); if (!np) return;
  if (np.length < 6) return toast('Password must be at least 6 characters');
  try {
    await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, cur));
    await updatePassword(auth.currentUser, np);
    toast('Password changed');
  } catch (e) { toast(String(e.code || '').includes('invalid') || String(e.code || '').includes('wrong') ? 'Current password is wrong' : 'Could not change password'); }
});

// ---------- First-time setup (no Cloud Shell needed) ----------
let settingUp = false;
async function checkSetup() {
  if (!configured) return;
  $('setup-btn').classList.remove('hidden');
  try {
    const s = await withTimeout(getDoc(doc(db, 'config', 'setup')), 10000, 'db-timeout');
    $('setup-btn').classList.toggle('hidden', s.exists());
  } catch (e) {
    const c = String(e.code || e.message || '');
    $('setup-btn').classList.remove('hidden');
    $('login-err').textContent = c.includes('permission')
      ? 'Tap "First-time setup" below to create the admin account'
      : 'Database: ' + (await diagnoseDb());
  }
}
$('setup-btn').addEventListener('click', () => { $('setup-form').classList.remove('hidden'); $('setup-btn').classList.add('hidden'); });
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('su-err'); err.textContent = 'Creating…';
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const name = $('su-name').value.trim(), username = cleanUser($('su-user').value), password = $('su-pass').value;
  settingUp = true;
  try {
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw { code: 'Username: 3–30 lowercase letters/numbers' };
    const email = `${username}@${DOMAIN}`;
    let cred;
    try { cred = await createUserWithEmailAndPassword(auth, email, password); }
    catch (x) {
      if (!String(x.code).includes('email-already-in-use')) throw x;
      cred = await signInWithEmailAndPassword(auth, email, password); // created earlier, finish setup
    }
    const uid = cred.user.uid;
    const b = writeBatch(db);
    b.set(doc(db, 'users', uid), { name, username, department: 'Management', role: 'admin', disabled: false, createdAt: serverTimestamp() });
    b.set(doc(db, 'usernames', username), { email, uid });
    b.set(doc(db, 'config', 'setup'), { done: true, by: uid, at: serverTimestamp() });
    await withTimeout(b.commit(), 15000, 'db-timeout');
    settingUp = false;
    err.textContent = '';
    $('setup-form').classList.add('hidden');
    toast('Admin created — welcome!', 3000);
    onLogin(cred.user);
  } catch (x) {
    settingUp = false;
    const c = String(x.code || x.message || '');
    err.textContent = c.includes('permission') ? 'Not allowed: setup was already done, or the security rules are not published'
      : c.includes('operation-not-allowed') ? 'Switch on Email/Password sign-in in Firebase first'
        : c.includes('wrong') || c.includes('invalid') ? 'That username exists with a different password'
          : c.includes('weak-password') ? 'Password must be at least 6 characters'
            : c === 'db-timeout' ? 'Database: ' + (await diagnoseDb())
              : (c.includes('/') ? 'Failed: ' + c.replace('auth/', '') : c);
    if (auth.currentUser) signOut(auth).catch(() => {});
  }
  btn.disabled = false;
});

async function onLogin(user) {
  let snap = null, readErr = null;
  try { snap = await withTimeout(getDoc(doc(db, 'users', user.uid)), 12000, 'db-timeout'); } catch (e) { readErr = e; }
  // Password correct but no profile yet, and first-time setup never finished → finish it now (rules allow this once).
  if (readErr && String(readErr.code || '').includes('permission')) {
    try {
      const st = await withTimeout(getDoc(doc(db, 'config', 'setup')), 10000, 'db-timeout');
      if (!st.exists()) {
        const username = String(user.email || '').split('@')[0].split('.')[0];
        const b = writeBatch(db);
        b.set(doc(db, 'users', user.uid), { name: username === 'admin' ? 'FitX Admin' : username, username, department: 'Management', role: 'admin', disabled: false, createdAt: serverTimestamp() });
        b.set(doc(db, 'usernames', username), { email: user.email, uid: user.uid });
        b.set(doc(db, 'config', 'setup'), { done: true, by: user.uid, at: serverTimestamp() });
        await withTimeout(b.commit(), 15000, 'db-timeout');
        toast('Admin account set up — welcome!', 3000);
        snap = await getDoc(doc(db, 'users', user.uid)); readErr = null;
      }
    } catch (e) { readErr = e; }
  }
  if (!snap || !snap.exists() || snap.data().disabled) {
    await signOut(auth);
    show('s-login');
    const rc = readErr ? String(readErr.code || readErr.message || '') : '';
    $('login-err').textContent = readErr
      ? (rc === 'db-timeout' || rc.includes('unavailable') ? 'Password OK, but database problem: ' + (await diagnoseDb())
        : rc.includes('permission') ? 'Password OK, but this account has no profile yet. Tap "First-time setup" below and enter the same username and password.'
          : 'Password OK, database error: ' + rc)
      : snap && snap.exists() ? 'This account is disabled — contact admin' : 'Account not set up — contact admin';
    return;
  }
  me = { uid: user.uid, ...snap.data() };
  renderMe();
  show('s-main');
  // Signed out by admin (disabled / deleted / password reset)?
  unsubs.push(onSnapshot(doc(db, 'users', user.uid), (s) => {
    if (!s.exists() || s.data().disabled) { toast('Your account was changed by the admin — sign in again', 4000); signOut(auth); return; }
    me = { uid: user.uid, ...s.data() }; renderMe();
  }, () => {}));
  watchTeam();
  watchIncoming();
  watchRecents();
  if (me.role === 'admin') watchAdmin();
  ping();
  heartbeat = setInterval(ping, 60000);
  if (native) { Native.startService().catch(() => {}); refreshChecks(); }
  else $('checks').innerHTML = '<li class="muted">Background ringing works in the Android app</li>';
}

function renderMe() {
  $('me-chip').textContent = me.name;
  $('set-name').textContent = me.name;
  $('set-user').textContent = `@${me.username}${me.department ? ' · ' + me.department : ''}${me.role === 'admin' ? ' · Admin' : ''}`;
  $('nav-admin').classList.toggle('hidden', me.role !== 'admin');
}

function onLogout() {
  unsubs.forEach((u) => u()); unsubs = [];
  clearInterval(heartbeat);
  me = null; users = [];
  if (current) current.finish('');
  show('s-login');
}

function ping() {
  if (!me) return;
  updateDoc(doc(db, 'users', me.uid), { lastSeen: serverTimestamp(), appVersion: VERSION, platform: Capacitor.getPlatform() }).catch(() => {});
}

// ---------- Reliability checklist (Settings) ----------
async function refreshChecks() {
  if (!native || !me) return;
  try {
    const r = await Native.checkReliability();
    const row = (ok, label, fix, act) => `<li><span><span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span> ${label}</span>${ok ? '' : `<button class="btn small" data-fix="${act}">${fix}</button>`}</li>`;
    $('checks').innerHTML = [
      row(r.notifications, 'Notifications allowed', 'Allow', 'notif'),
      row(r.battery, 'Battery: unrestricted', 'Fix', 'battery'),
      row(r.fullScreen, 'Show calls on lock screen', 'Allow', 'fullscreen'),
      row(r.service, 'Ready for calls in background', 'Start', 'service'),
    ].join('');
    const bad = [r.notifications, r.battery, r.fullScreen].filter((x) => !x).length;
    if (bad && !sessionStorage.getItem('warned')) { sessionStorage.setItem('warned', '1'); toast('Settings → fix the ✗ items so calls can ring', 4000); }
  } catch (e) { $('checks').innerHTML = '<li class="muted">Could not check this phone</li>'; }
}
$('checks').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fix]'); if (!b) return;
  const a = b.dataset.fix;
  if (a === 'notif') Native.openNotificationSettings();
  if (a === 'battery') Native.openBatterySettings();
  if (a === 'fullscreen') Native.openFullScreenSettings();
  if (a === 'service') Native.startService().then(() => setTimeout(refreshChecks, 800));
});

// ---------- Team ----------
function watchTeam() {
  unsubs.push(onSnapshot(collection(db, 'users'), (snap) => {
    users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => u.uid !== me.uid && !u.disabled)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderTeam();
  }, () => {}));
}
const isOnline = (u) => Date.now() - ms(u.lastSeen) < 150000;
function renderTeam() {
  const q = $('search').value.trim().toLowerCase();
  const list = users.filter((u) => !q || `${u.name} ${u.username} ${u.department || ''}`.toLowerCase().includes(q));
  $('contacts').innerHTML = list.length ? list.map((u) => `
    <li>
      <div class="avatar ${isOnline(u) ? 'on' : ''}">${esc(initials(u.name))}</div>
      <div class="who"><b>${esc(u.name)}</b><small>${esc(u.department || '@' + u.username)}${isOnline(u) ? ' · online' : ''}</small></div>
      <button class="icon-btn" data-call="${u.uid}" data-type="audio" aria-label="Voice call"><svg><use href="#i-phone"/></svg></button>
      <button class="icon-btn" data-call="${u.uid}" data-type="video" aria-label="Video call"><svg><use href="#i-video"/></svg></button>
    </li>`).join('') : `<li class="empty">${q ? 'No match' : 'No other employees yet'}</li>`;
}
$('search').addEventListener('input', renderTeam);
setInterval(() => { if (me && !$('tab-contacts').classList.contains('hidden')) renderTeam(); }, 60000);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-call]');
  if (!b) return;
  const u = users.find((x) => x.uid === b.dataset.call) || recentPeers[b.dataset.call];
  if (u) startCall(u, b.dataset.type);
});

// ---------- Recents (users/{me}/log, newest first — no paid indexes needed) ----------
const recentPeers = {};
function watchRecents() {
  const q = query(collection(db, 'users', me.uid, 'log'), orderBy('createdAtMs', 'desc'), limit(50));
  unsubs.push(onSnapshot(q, (s) => renderRecents(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => {}));
}
function renderRecents(all) {
  $('recents').innerHTML = all.length ? all.map((c) => {
    const out = c.dir === 'out';
    recentPeers[c.peerUid] = { uid: c.peerUid, name: c.peerName };
    const missed = !out && ['missed', 'cancelled', 'ringing'].includes(c.status);
    const dur = c.duration ? fmtDur(c.duration) : '';
    const label = missed ? 'Missed' : c.status === 'declined' ? 'Declined' : c.status === 'busy' ? 'Busy'
      : (!out || c.status === 'answered' || c.status === 'ended') ? (out ? 'Outgoing' : 'Incoming') : 'Not answered';
    return `<li>
      <div class="avatar">${esc(initials(c.peerName))}</div>
      <div class="who"><b>${esc(c.peerName)}</b><small class="dir ${missed ? 'missed' : ''}">${out ? '↗' : '↙'} ${label} ${c.type === 'video' ? 'video' : 'voice'}${dur ? ' · ' + dur : ''} · ${ago(c.createdAtMs)}</small></div>
      <button class="icon-btn" data-call="${esc(c.peerUid)}" data-type="${c.type === 'video' ? 'video' : 'audio'}"><svg><use href="#i-${c.type === 'video' ? 'video' : 'phone'}"/></svg></button>
    </li>`;
  }).join('') : '<li class="empty">No calls yet</li>';
}
function writeLog(ownerUid, callId, data) {
  return setDoc(doc(db, 'users', ownerUid, 'log', callId), data, { merge: true }).catch(() => {});
}
function logFinal(s) {
  if (!s || !me) return;
  const duration = s.startedAt ? Math.max(0, Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000)) : 0;
  const upd = { status: s.finalStatus || 'ended', duration };
  writeLog(me.uid, s.id, upd);
  if (s.role === 'caller') writeLog(s.peer.uid, s.id, upd);
}

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['contacts', 'recents', 'admin', 'settings'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'settings') refreshChecks();
}));
$('opt-saver').checked = saverOn();
$('opt-saver').addEventListener('change', (e) => { try { localStorage.setItem('saver', e.target.checked ? '1' : '0'); } catch (x) {} });

// ---------- Admin (runs in the app — free plan) ----------
async function newLogin(username, password) {
  const ca = creator();
  let email = `${username}@${DOMAIN}`;
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(ca, email, password);
  } catch (e) {
    if (!String(e.code).includes('email-already-in-use')) throw e;
    // Old login with this name exists (deleted employee / password reset) → make a fresh hidden login.
    email = `${username}.${Date.now().toString(36)}@${DOMAIN}`;
    cred = await createUserWithEmailAndPassword(ca, email, password);
  }
  const uid = cred.user.uid;
  await signOut(ca).catch(() => {});
  return { uid, email };
}
function adminErr(e) {
  const c = String((e && e.code) || (e && e.message) || '');
  if (c.includes('weak-password')) return 'Password must be at least 6 characters';
  if (c.includes('permission')) return 'Not allowed — are you an admin?';
  if (c.includes('network')) return 'No internet connection';
  if (c.includes('too-many')) return 'Too many attempts — wait a minute';
  return 'Failed: ' + c.replace('auth/', '');
}

function watchAdmin() {
  unsubs.push(onSnapshot(collection(db, 'users'), (snap) => {
    const all = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    $('admin-list').innerHTML = all.map((u) => `
      <li>
        <div class="avatar">${esc(initials(u.name))}</div>
        <div class="who"><b>${esc(u.name)}${u.role === 'admin' ? '<span class="badge">admin</span>' : ''}${u.disabled ? '<span class="badge off">disabled</span>' : ''}</b>
          <small>@${esc(u.username)}${u.department ? ' · ' + esc(u.department) : ''}</small></div>
        <div class="actions">
          ${u.uid === me.uid ? '' : `<button class="btn small" data-adm="pass" data-uid="${u.uid}">Password</button>
          <button class="btn small" data-adm="${u.disabled ? 'enable' : 'disable'}" data-uid="${u.uid}">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn small" data-adm="delete" data-uid="${u.uid}">Delete</button>`}
        </div>
      </li>`).join('');
    $('admin-list')._users = all;
  }, () => {}));
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-msg'); msg.textContent = 'Creating…';
  const btn = e.target.querySelector('button'); btn.disabled = true;
  const name = $('a-name').value.trim(), username = cleanUser($('a-user').value), password = $('a-pass').value;
  const department = $('a-dept').value.trim(), role = $('a-role').value === 'admin' ? 'admin' : 'employee';
  try {
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw { code: 'Username: 3–30 lowercase letters, numbers, . _ -' };
    const taken = await getDoc(doc(db, 'usernames', username));
    if (taken.exists()) throw { code: 'That username is already taken' };
    const { uid, email } = await newLogin(username, password);
    await setDoc(doc(db, 'users', uid), { name, username, department, role, disabled: false, createdAt: serverTimestamp(), createdBy: me.uid });
    await setDoc(doc(db, 'usernames', username), { email, uid });
    msg.textContent = '';
    toast(`Account created — username: ${username}`, 4000);
    e.target.reset();
  } catch (err) { msg.textContent = err.code && !String(err.code).includes('/') ? err.code : adminErr(err); }
  btn.disabled = false;
});

$('admin-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-adm]'); if (!b) return;
  const u = ($('admin-list')._users || []).find((x) => x.uid === b.dataset.uid); if (!u) return;
  try {
    if (b.dataset.adm === 'pass') {
      const p = prompt(`New password for ${u.name} (min 6 characters):`);
      if (!p) return;
      if (p.length < 6) return toast('Password must be at least 6 characters');
      // Free plan can't change another person's password directly, so give them a fresh login
      // behind the same username, and move their profile across.
      const { uid, email } = await newLogin(u.username, p);
      const { uid: _old, ...profile } = u;
      await setDoc(doc(db, 'users', uid), { ...profile, lastSeen: null, createdAt: serverTimestamp() });
      await setDoc(doc(db, 'usernames', u.username), { email, uid });
      await deleteDoc(doc(db, 'users', u.uid));
      toast(`Password changed for ${u.name}`);
    } else if (b.dataset.adm === 'disable' || b.dataset.adm === 'enable') {
      await updateDoc(doc(db, 'users', u.uid), { disabled: b.dataset.adm === 'disable' });
      toast(b.dataset.adm === 'disable' ? 'Account disabled' : 'Account enabled');
    } else if (b.dataset.adm === 'delete') {
      if (!confirm(`Delete ${u.name}'s account permanently?`)) return;
      await deleteDoc(doc(db, 'users', u.uid));
      await deleteDoc(doc(db, 'usernames', u.username)).catch(() => {});
      toast('Account deleted');
    }
  } catch (err) { toast(adminErr(err)); }
});

// ---------- Calling ----------
let speakerOn = false, muted = false, camOn = true;
function setSpeaker(on) {
  speakerOn = on;
  $('b-speaker').classList.toggle('active', on);
  if (native) Native.setSpeaker({ on }).catch(() => {});
}

function hooks() {
  return {
    onRemoteStream: (stream) => {
      if (current?.type === 'video') { $('remote-video').srcObject = stream; $('remote-audio').srcObject = null; }
      else $('remote-audio').srcObject = stream;
      $('remote-video').play?.().catch(() => {}); $('remote-audio').play?.().catch(() => {});
    },
    onState: (t) => { if (t) $('c-status').textContent = t; else startTimerLabel(); },
    onConnected: () => {
      Tone.stop();
      current.startedAt = Date.now();
      startTimerLabel();
      if (current.type === 'video') $('s-call').classList.add('video-on');
    },
    onQuality: (q) => { $('c-quality').textContent = q; },
    onEnded: (why) => endUi(why),
  };
}

function startTimerLabel() {
  clearInterval(callTimer);
  const tick = () => { if (current?.startedAt) $('c-status').textContent = fmtDur(Math.round((Date.now() - current.startedAt) / 1000)); };
  tick(); callTimer = setInterval(tick, 1000);
}

function openCallUi(peerName, type) {
  muted = false; camOn = true;
  $('b-mute').classList.remove('active'); $('b-cam').classList.remove('active');
  $('local-video').style.visibility = 'visible';
  $('c-name').textContent = peerName; $('c-avatar').textContent = initials(peerName);
  $('c-quality').textContent = '';
  $('s-call').classList.toggle('is-video', type === 'video');
  $('s-call').classList.remove('video-on');
  $('local-video').classList.remove('back');
  show('s-call');
  if (native) Native.startCall({ video: type === 'video' }).catch(() => {});
  setSpeaker(type === 'video');
}

async function startCall(peer, type) {
  if (current) return toast('Already in a call');
  if (!navigator.onLine) return toast('No internet connection');
  current = new CallSession({ db, me, peer, type, role: 'caller', saver: saverOn(), hooks: hooks() });
  openCallUi(peer.name, type);
  $('c-status').textContent = 'Calling…';
  const s = current;
  try {
    await s.start();
    const now = Date.now();
    writeLog(me.uid, s.id, { peerUid: peer.uid, peerName: peer.name, dir: 'out', type, status: 'ringing', createdAtMs: now });
    writeLog(peer.uid, s.id, { peerUid: me.uid, peerName: me.name, dir: 'in', type, status: 'ringing', createdAtMs: now });
    if (type === 'video' && current === s) $('local-video').srcObject = s.local;
    if (current === s && !s.connectedOnce) Tone.ringback();
  } catch (e) {
    console.warn(e);
    const why = e && e.name === 'NotAllowedError' ? 'Allow microphone/camera permission' : 'Could not start the call';
    s.finish(why);
  }
}

function endUi(why) {
  const s = current;
  Tone.stop();
  clearInterval(callTimer);
  if (native) Native.endCall().catch(() => {});
  $('remote-video').srcObject = null; $('remote-audio').srcObject = null; $('local-video').srcObject = null;
  current = null;
  logFinal(s);
  if (why) toast(why);
  show(me ? 's-main' : 's-login');
}

$('b-end').addEventListener('click', () => current?.hangup());
$('b-mute').addEventListener('click', () => { muted = !muted; current?.setMuted(muted); $('b-mute').classList.toggle('active', muted); });
$('b-speaker').addEventListener('click', () => setSpeaker(!speakerOn));
$('b-cam').addEventListener('click', () => { camOn = !camOn; current?.setCamera(camOn); $('b-cam').classList.toggle('active', !camOn); $('local-video').style.visibility = camOn ? 'visible' : 'hidden'; });
$('b-flip').addEventListener('click', async () => {
  try { const f = await current?.flipCamera(); $('local-video').srcObject = current.local; $('local-video').classList.toggle('back', f === 'environment'); }
  catch (e) { toast('Could not switch camera'); }
});

// ---------- Incoming ----------
function watchIncoming() {
  const q = query(collection(db, 'calls'), where('to', '==', me.uid), where('status', '==', 'ringing'));
  unsubs.push(onSnapshot(q, (snap) => {
    snap.docChanges().forEach((ch) => {
      const d = ch.doc.data(); const id = ch.doc.id;
      if (ch.type === 'added') {
        const age = Date.now() - (ms(d.createdAt) || d.createdAtMs || 0);
        if (age > 60000) return; // stale
        if (current || (incoming && incoming.id !== id)) {
          updateDoc(ch.doc.ref, { status: 'busy', endedAt: serverTimestamp() }).catch(() => {});
          return;
        }
        updateDoc(ch.doc.ref, { delivered: true }).catch(() => {});
        showIncoming(id, d);
      }
      if (ch.type === 'removed' && incoming && incoming.id === id) {
        if (!incoming.accepting) {
          Tone.stop(); incoming = null;
          if (native) { Native.cancelIncoming().catch(() => {}); Native.showMissed({ callId: id, fromName: d.fromName, callType: d.type }).catch(() => {}); }
          toast(`Missed call from ${d.fromName}`); show('s-main');
        }
      }
    });
  }, (err) => console.warn('incoming', err)));
}

async function showIncoming(id, d) {
  incoming = { id, data: d };
  $('in-name').textContent = d.fromName;
  $('in-avatar').textContent = initials(d.fromName);
  $('in-type').textContent = d.type === 'video' ? 'Incoming HD video call' : 'Incoming HD voice call';
  show('s-incoming');
  let rangNatively = false;
  if (native) {
    try { rangNatively = (await Native.ringIncoming({ callId: id, fromName: d.fromName, callType: d.type })).shown; } catch (e) {}
  }
  if (!rangNatively && incoming && incoming.id === id) Tone.ring();
  if (pendingLink && pendingLink.id === id) { const a = pendingLink.action; pendingLink = null; if (a === 'answer') acceptIncoming(); if (a === 'decline') declineIncoming(); }
}

async function acceptIncoming() {
  if (!incoming || incoming.accepting) return;
  incoming.accepting = true;
  Tone.stop();
  if (native) Native.cancelIncoming().catch(() => {});
  const { id, data } = incoming;
  current = new CallSession({ db, me, peer: { uid: data.from, name: data.fromName }, type: data.type, role: 'callee', callId: id, saver: saverOn(), hooks: hooks() });
  const s = current;
  openCallUi(data.fromName, data.type);
  $('c-status').textContent = 'Connecting…';
  try {
    await s.accept(data);
    if (data.type === 'video' && current === s) $('local-video').srcObject = s.local;
  } catch (e) {
    console.warn(e);
    s.setStatus('ended');
    s.finish(e && e.name === 'NotAllowedError' ? 'Allow microphone/camera permission' : 'Could not connect');
  }
  incoming = null;
}

async function declineIncoming() {
  if (!incoming) return;
  Tone.stop();
  if (native) Native.cancelIncoming().catch(() => {});
  const ref = doc(db, 'calls', incoming.id);
  incoming = null;
  show('s-main');
  await updateDoc(ref, { status: 'declined', endedAt: serverTimestamp(), endedBy: me.uid }).catch(() => {});
}
$('in-accept').addEventListener('click', acceptIncoming);
$('in-decline').addEventListener('click', declineIncoming);

// ---------- Notification taps: fitxcall://call?id=...&action=answer|decline|open ----------
function handleLink(url) {
  if (!url || !url.startsWith('fitxcall://')) return;
  const u = new URL(url.replace('fitxcall://', 'https://x/'));
  const id = u.searchParams.get('id'); const action = u.searchParams.get('action') || 'open';
  if (!id) return;
  if (incoming && incoming.id === id) {
    if (action === 'answer') acceptIncoming();
    else if (action === 'decline') declineIncoming();
  } else pendingLink = { id, action };
}
if (native) {
  App.addListener('appUrlOpen', (e) => handleLink(e.url));
  App.getLaunchUrl().then((r) => r && handleLink(r.url)).catch(() => {});
  App.addListener('backButton', () => {
    if (current || incoming) return; // never leave a call by accident
    const onTeam = !$('tab-contacts').classList.contains('hidden');
    if (!onTeam) document.querySelector('.tabs button[data-tab="contacts"]').click();
    else App.minimizeApp();
  });
  App.addListener('appStateChange', ({ isActive }) => {
    inBackground = !isActive;
    if (isActive) {
      ping(); refreshChecks();
      if (incoming && !current) { Native.cancelIncoming().catch(() => {}); if (!Tone.timer) Tone.ring(); }
    }
  });
}

window.addEventListener('online', () => toast('Back online'));
window.addEventListener('offline', () => toast('No internet connection'));

// ---------- Boot ----------
if (!configured) show('s-setup');
else pickDatabase().then((id) => {
  DBID = id;
  db = initializeFirestore(fb, { experimentalForceLongPolling: true }, id);
  onAuthStateChanged(auth, (u) => { if (settingUp) return; if (u) onLogin(u); else { onLogout(); checkSetup(); } });
});
