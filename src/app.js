// FitX Call — app shell (free Firebase "Spark" plan: no Cloud Functions, no server push)
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, getAuth, indexedDBLocalPersistence, browserLocalPersistence, inMemoryPersistence,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
} from 'firebase/auth';
import {
  initializeFirestore, writeBatch, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, arrayRemove,
} from 'firebase/firestore';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { CallSession } from './call.js';
import { createChat } from './chat.js';
import { SipPhone, loadSip, saveSip } from './sip.js';
import { Conference, MAX_VOICE, MAX_VIDEO } from './conf.js';

const CFG = window.FITX_CONFIG || {};
const $ = (id) => document.getElementById(id);
const native = Capacitor.isNativePlatform();
const Native = registerPlugin('AudioRoute');
const VERSION = '1.1';

// ---------- UI helpers ----------
const screens = ['s-loading', 's-setup', 's-login', 's-main', 's-chat', 's-incoming', 's-call', 's-conf'];
function show(id) {
  screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));
  if (typeof updateCallBar === 'function') updateCallBar(id);
}
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
// Small in-app dialog (passwords are hidden, unlike the browser prompt()).
function ask({ title, text = '', fields = [], ok = 'OK' }) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    $('modal-text').classList.toggle('hidden', !text);
    $('modal-ok').textContent = ok;
    $('modal-fields').innerHTML = fields.map((f, i) => `<label>${esc(f.label)}<input id="mf-${i}" type="${f.type || 'text'}" ${f.min ? `minlength="${f.min}"` : ''} autocomplete="off" ${f.required === false ? '' : 'required'}></label>`).join('');
    $('modal').classList.remove('hidden');
    setTimeout(() => { const first = $('mf-0'); if (first) first.focus(); }, 50);
    const done = (val) => { $('modal').classList.add('hidden'); $('modal-form').onsubmit = null; $('modal-cancel').onclick = null; resolve(val); };
    $('modal-cancel').onclick = () => done(null);
    $('modal-form').onsubmit = (e) => { e.preventDefault(); done(fields.map((_, i) => $('mf-' + i).value)); };
  });
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

const chat = createChat({
  getDb: () => db, getMe: () => me, getUsers: () => users, toast, show, native, Native, esc, initials, ago, $,
  startCall: (peer, type) => startCall(peer, type),
});
const homeScreen = () => (chat.isOpenAny() ? 's-chat' : 's-main');

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
    nativeSignIn(email, $('login-pass').value);
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
  if (native) { Native.nativeSignOut().catch(() => {}); Native.stopService().catch(() => {}); }
  await signOut(auth);
});

$('change-pass').addEventListener('click', async () => {
  const v = await ask({ title: 'Change my password', fields: [
    { label: 'Current password', type: 'password' }, { label: 'New password (6+ characters)', type: 'password', min: 6 }], ok: 'Change' });
  if (!v) return;
  const [cur, np] = v;
  try {
    await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, cur));
    await updatePassword(auth.currentUser, np);
    nativeSignIn(auth.currentUser.email, np); // keep background ringing signed in
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
    nativeSignIn(email, password);
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
  chat.start();
  sip.start();
  watchIncoming();
  watchConfInvites();
  watchRecents();
  if (me.role === 'admin') watchAdmin();
  ping();
  heartbeat = setInterval(ping, 60000);
  if (native) {
    Native.setPref({ key: 'msgNotif', value: pref('msgNotif', true) }).catch(() => {});
    if (pref('ringClosed', true)) {
      Native.startService().catch(() => {});
      setTimeout(async () => { if (me && !(await ensureNativeLogin(false))) ensureNativeLogin(true); }, 2500);
    }
  }
  refreshChecks();
}

function renderMe() {
  $('me-chip').textContent = me.name;
  $('set-name').textContent = me.name;
  $('set-avatar').textContent = initials(me.name);
  $('set-user').textContent = `@${me.username}${me.department ? ' · ' + me.department : ''}${me.role === 'admin' ? ' · Admin' : ''}`;
  $('nav-admin').classList.toggle('hidden', me.role !== 'admin');
}

function onLogout() {
  unsubs.forEach((u) => u()); unsubs = [];
  chat.stop();
  sip.stop();
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
// The background service has its own native login so it can ring when the app is closed.
let nativePending = null;
function nativeSignIn(email, password) {
  if (!native) return Promise.resolve(false);
  nativePending = Native.nativeSignIn({ email, password, db: DBID }).then(() => true).catch(() => false);
  return nativePending;
}
async function ensureNativeLogin(askNow) {
  if (!native || !me || !auth.currentUser) return;
  if (nativePending) await nativePending;
  let st = { signedIn: false };
  try { st = await Native.nativeStatus(); } catch (e) { return; }
  if (st.signedIn && st.uid === auth.currentUser.uid) return true;
  if (!askNow) return false;
  const v = await ask({ title: 'Ring when app is closed', text: 'Enter your password once so calls can ring even when FitX Call is closed.', fields: [{ label: 'Password', type: 'password' }], ok: 'Turn on' });
  if (!v) return false;
  const pw = v[0];
  const ok = await nativeSignIn(auth.currentUser.email, pw);
  toast(ok ? 'Done — calls will ring even when the app is closed' : 'Wrong password — try again in Settings', 3500);
  if (ok) setPref('ringClosed', true);
  refreshChecks();
  return ok;
}

// ---------- Settings switches ----------
const pref = (k, def) => { try { const v = localStorage.getItem(k); return v === null ? def : v === '1'; } catch (e) { return def; } };
function setPref(k, on) {
  try { localStorage.setItem(k, on ? '1' : '0'); } catch (e) {}
  if (native && k === 'msgNotif') Native.setPref({ key: 'msgNotif', value: on }).catch(() => {});
}
async function refreshChecks() {
  $('opt-saver').checked = pref('saver', false);
  $('opt-speaker').checked = pref('speakerDefault', false);
  $('opt-msg').checked = pref('msgNotif', true);
  if (!native) { $('opt-ring').checked = false; $('opt-ring').disabled = true; $('set-status').textContent = 'Install the Android app to receive calls in the background.'; return; }
  if (!me) return;
  try {
    const r = await Native.checkReliability();
    const nativeOk = !!(await ensureNativeLogin(false));
    const ringOn = pref('ringClosed', true) && nativeOk && r.service;
    $('opt-ring').checked = ringOn;
    $('perm-notif').checked = !!r.notifications;
    $('perm-battery').checked = !!r.battery;
    $('perm-full').checked = !!r.fullScreen;
    const missing = [];
    if (!ringOn) missing.push('Ring when app is closed');
    if (!r.notifications) missing.push('Notifications');
    if (!r.battery) missing.push('Battery');
    if (!r.fullScreen) missing.push('Lock screen');
    const st = $('set-status');
    st.classList.toggle('ok', !missing.length); st.classList.toggle('warn', !!missing.length);
    st.textContent = missing.length ? `⚠ Calls may not ring — turn on: ${missing.join(', ')}` : '✓ All set — calls will ring even when the app is closed';
    if (missing.length && !sessionStorage.getItem('warned')) { sessionStorage.setItem('warned', '1'); toast('Settings → turn on the switches so calls can ring', 4000); }
  } catch (e) { $('set-status').textContent = 'Could not check this phone'; }
}
// App options
$('opt-saver').addEventListener('change', (e) => setPref('saver', e.target.checked));
$('opt-speaker').addEventListener('change', (e) => setPref('speakerDefault', e.target.checked));
$('opt-msg').addEventListener('change', (e) => setPref('msgNotif', e.target.checked));
$('opt-ring').addEventListener('change', async (e) => {
  if (!native) return;
  if (e.target.checked) {
    setPref('ringClosed', true);
    await Native.startService().catch(() => {});
    await ensureNativeLogin(true);
  } else {
    setPref('ringClosed', false);
    await Native.nativeSignOut().catch(() => {});
    await Native.stopService().catch(() => {});
    toast('Calls will only ring while FitX Call is open', 3500);
  }
  setTimeout(refreshChecks, 600);
});
// Phone permissions: switches open the system page (Android doesn't let apps flip these directly)
document.querySelectorAll('[data-perm]').forEach((sw) => sw.addEventListener('change', (e) => {
  e.target.checked = !e.target.checked; // real state is refreshed when you come back
  const a = e.target.dataset.perm;
  if (a === 'notif') Native.openNotificationSettings();
  if (a === 'battery') Native.openBatterySettings();
  if (a === 'fullscreen') Native.openFullScreenSettings();
}));
$('perm-auto').addEventListener('click', async () => {
  const r = await Native.openAutostart().catch(() => ({}));
  if (!r.brandPage) toast('Find "Autostart" or "Background activity" here and turn it on', 4000);
});
if (!native) document.body.classList.add('web');

// ---------- Appearance: theme, accent, text size, layout, corners ----------
const LOOK_DEFAULTS = { 'fx-theme': 'dark', 'fx-accent': 'orange', 'fx-text': '100', 'fx-density': 'comfortable', 'fx-corners': 'rounded' };
const lookGet = (k) => { try { return localStorage.getItem(k) || LOOK_DEFAULTS[k]; } catch (e) { return LOOK_DEFAULTS[k]; } };
const darkMQ = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;
function applyLook() {
  const d = document.documentElement;
  let theme = lookGet('fx-theme');
  if (theme === 'auto') theme = darkMQ && darkMQ.matches ? 'light' : 'dark';
  d.dataset.theme = theme;
  d.dataset.accent = lookGet('fx-accent');
  d.dataset.density = lookGet('fx-density');
  d.dataset.corners = lookGet('fx-corners');
  const pct = Number(lookGet('fx-text')) || 100;
  const bg = getComputedStyle(d).getPropertyValue('--bg').trim() || '#0b0b0c';
  const light = theme === 'light' || theme === 'sand';
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = bg;
  if (native) {
    Native.setTextZoom({ percent: pct }).catch(() => {});
    Native.setSystemBars({ color: bg, light }).catch(() => {});
  } else document.body.style.zoom = pct / 100;
  document.querySelectorAll('#appearance [data-opt]').forEach((g) => {
    const v = lookGet(g.dataset.opt);
    g.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
}
$('appearance').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  const g = b.closest('[data-opt]'); if (!g) return;
  try { localStorage.setItem(g.dataset.opt, b.dataset.v); } catch (x) {}
  applyLook();
});
$('look-reset').addEventListener('click', () => {
  Object.keys(LOOK_DEFAULTS).forEach((k) => { try { localStorage.removeItem(k); } catch (x) {} });
  applyLook(); toast('Back to the FitX look');
});
if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', () => { if (lookGet('fx-theme') === 'auto') applyLook(); });
applyLook();

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
      <button class="icon-btn" data-chat="${u.uid}" aria-label="Message"><svg><use href="#i-chat"/></svg></button>
      <button class="icon-btn" data-call="${u.uid}" data-type="audio" aria-label="Voice call"><svg><use href="#i-phone"/></svg></button>
      <button class="icon-btn" data-call="${u.uid}" data-type="video" aria-label="Video call"><svg><use href="#i-video"/></svg></button>
    </li>`).join('') : `<li class="empty">${q ? 'No match' : 'No other employees yet'}</li>`;
}
$('search').addEventListener('input', renderTeam);
setInterval(() => { if (me && !$('tab-contacts').classList.contains('hidden')) renderTeam(); }, 60000);

document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-chat]');
  if (c) { const u = users.find((x) => x.uid === c.dataset.chat); if (u) chat.openWith(u); return; }
  const dl = e.target.closest('[data-dial]');
  if (dl) { if (dl.dataset.route === 'gsm') dialGsm(dl.dataset.dial); else dialSip(dl.dataset.dial); return; }
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
    if (c.type === 'conf') {
      return `<li>
        <div class="avatar"><svg style="width:22px;height:22px"><use href="#i-group"/></svg></div>
        <div class="who"><b>${esc(c.peerName || 'Group call')}</b><small class="dir">${out ? '↗' : '↙'} Group ${c.media === 'video' ? 'video' : 'voice'} call${c.duration ? ' · ' + fmtDur(c.duration) : ''} · ${ago(c.createdAtMs)}</small></div>
      </li>`;
    }
    if (c.type === 'sip' || c.type === 'phone') {
      const num = c.number || String(c.peerUid || '').replace(/^tel:/, '');
      const miss = !out && ['missed', 'cancelled'].includes(c.status);
      const lbl = c.type === 'phone' ? 'Phone call' : miss ? 'Missed SIP call' : c.status === 'declined' ? 'Declined SIP call' : 'SIP call';
      const route = c.type === 'phone' ? 'gsm' : 'sip';
      return `<li>
        <div class="avatar">#</div>
        <div class="who"><b>${esc(c.peerName || num)}</b><small class="dir ${miss ? 'missed' : ''}">${out ? '↗' : '↙'} ${lbl}${c.duration ? ' · ' + fmtDur(c.duration) : ''} · ${ago(c.createdAtMs)}</small></div>
        <button class="icon-btn" data-dial="${esc(num)}" data-route="${route}"><svg><use href="#i-${route === 'gsm' ? 'sim' : 'phone'}"/></svg></button>
      </li>`;
    }
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
  if (s.kind === 'sip') {
    const duration = s.startedAt ? Math.max(0, Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000)) : 0;
    writeLog(me.uid, s.id, { peerUid: 'tel:' + s.number, peerName: s.peer.name, number: s.number, dir: s.role === 'caller' ? 'out' : 'in', type: 'sip', status: s.finalStatus || 'ended', duration, createdAtMs: s.createdAtMs });
    return;
  }
  const duration = s.startedAt ? Math.max(0, Math.round(((s.endedAt || Date.now()) - s.startedAt) / 1000)) : 0;
  const upd = { status: s.finalStatus || 'ended', duration };
  writeLog(me.uid, s.id, upd);
  if (s.role === 'caller') writeLog(s.peer.uid, s.id, upd);
}

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['contacts', 'chats', 'keypad', 'recents', 'admin', 'settings'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'settings') refreshChecks();
}));


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
      const v = await ask({ title: `New password for ${u.name}`, fields: [{ label: 'New password (6+ characters)', type: 'password', min: 6 }], ok: 'Change' });
      if (!v) return;
      const p = v[0];
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
      if (native) Native.callConnected({ startedAt: current.startedAt }).catch(() => {});
      if (current.type === 'video') {
        $('s-call').classList.add('video-on'); armHide();
        if (native) Native.setPip({ enabled: true }).catch(() => {});
        $('swap-hint').classList.add('show'); setTimeout(() => $('swap-hint').classList.remove('show'), 3500);
      }
    },
    onQuality: (q) => { $('c-quality').textContent = q; },
    onPeerHold: () => renderHold(),
    onEnded: (why) => endUi(why),
  };
}

// Video calls: hide the buttons after 4 s; tap the screen to bring them back.
let hideT = null;
function armHide() {
  clearTimeout(hideT);
  $('s-call').classList.remove('controls-hidden');
  if (typeof placeSmall === 'function' && smallPos) requestAnimationFrame(() => placeSmall(smallPos));
  if ($('s-call').classList.contains('video-on')) hideT = setTimeout(() => $('s-call').classList.add('controls-hidden'), 4000);
}
$('s-call').addEventListener('click', (e) => {
  if (!$('s-call').classList.contains('video-on')) return;
  if (e.target.classList && e.target.classList.contains('vsmall')) return;
  if (Date.now() - lastVideoTap < 450) return; // the tap that just moved/swapped the small video
  if (e.target.closest('button')) { armHide(); return; }
  if ($('s-call').classList.contains('controls-hidden')) armHide();
  else { clearTimeout(hideT); $('s-call').classList.add('controls-hidden'); }
});

// ----- Movable self-view: drag anywhere (snaps to a corner), tap to swap big/small -----
const vids = () => [$('local-video'), $('remote-video')];
let swapped = false, smallPos = null;
function resetVideoLayout(isVideo) {
  swapped = false; smallPos = null;
  vids().forEach((v) => { v.classList.remove('vsmall', 'vbig', 'snap', 'dragging'); v.style.left = ''; v.style.top = ''; });
  if (!isVideo) return;
  $('local-video').classList.add('vsmall'); $('remote-video').classList.add('vbig');
  requestAnimationFrame(() => placeSmall(null));
}
function smallEl() { return swapped ? $('remote-video') : $('local-video'); }
function bounds(el) {
  const W = innerWidth, H = innerHeight, w = el.offsetWidth || 120, h = el.offsetHeight || 160;
  const safeT = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0;
  const acts = document.querySelector('#s-call .call-actions');
  const hidden = document.querySelector('#s-call.controls-hidden');
  const bottomLimit = !hidden && acts ? acts.getBoundingClientRect().top - 12 : H - 24;
  return { W, H, w, h, minX: 12, maxX: W - w - 12, minY: 12 + safeT, maxY: Math.max(12 + safeT, bottomLimit - h) };
}
function placeSmall(pos) {
  const el = smallEl(), b = bounds(el);
  const p = pos || smallPos || { x: b.maxX, y: b.minY };   // default: top-right
  const x = Math.min(Math.max(b.minX, p.x), b.maxX), y = Math.min(Math.max(b.minY, p.y), b.maxY);
  el.style.left = x + 'px'; el.style.top = y + 'px';
  smallPos = { x, y };
}
function snapSmall() {
  const el = smallEl(), b = bounds(el);
  const cx = (smallPos.x + b.w / 2) < b.W / 2 ? b.minX : b.maxX;
  const cy = (smallPos.y + b.h / 2) < b.H / 2 ? b.minY : b.maxY;
  el.classList.add('snap'); placeSmall({ x: cx, y: cy });
  setTimeout(() => el.classList.remove('snap'), 260);
}
function swapVideos() {
  swapped = !swapped;
  const sm = smallEl(), bg = swapped ? $('local-video') : $('remote-video');
  bg.classList.remove('vsmall'); bg.classList.add('vbig'); bg.style.left = ''; bg.style.top = '';
  sm.classList.remove('vbig'); sm.classList.add('vsmall');
  placeSmall(smallPos);
}
let drag = null, lastVideoTap = 0;
vids().forEach((v) => {
  v.addEventListener('pointerdown', (e) => {
    if (!v.classList.contains('vsmall')) return;
    e.stopPropagation();
    drag = { el: v, sx: e.clientX, sy: e.clientY, ox: smallPos ? smallPos.x : v.offsetLeft, oy: smallPos ? smallPos.y : v.offsetTop, moved: false };
    try { v.setPointerCapture(e.pointerId); } catch (x) {}
    v.classList.add('dragging');
  });
  v.addEventListener('pointermove', (e) => {
    if (!drag || drag.el !== v) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    placeSmall({ x: drag.ox + dx, y: drag.oy + dy });
  });
  const end = (e) => {
    if (!drag || drag.el !== v) return;
    const moved = drag.moved; drag = null; v.classList.remove('dragging'); lastVideoTap = Date.now();
    if (e && e.type === 'pointercancel') { snapSmall(); return; }
    if (moved) snapSmall(); else swapVideos();
    if ($('s-call').classList.contains('video-on')) armHide();
  };
  v.addEventListener('pointerup', end);
  v.addEventListener('pointercancel', end);
});
window.addEventListener('resize', () => { if (smallPos && $('s-call').classList.contains('is-video') && !document.body.classList.contains('pip')) placeSmall(smallPos); });

// Native events: notification "End call" button, and picture-in-picture on/off
if (native) {
  Native.addListener('hangup', () => { if (current) current.hangup(); });
  Native.addListener('pip', ({ active }) => {
    if (active && current && $('s-call').classList.contains('hidden')) restoreCall();
    document.body.classList.toggle('pip', !!active);
    if (!active && smallPos) setTimeout(() => placeSmall(smallPos), 300);
  });
}

function startTimerLabel() {
  clearInterval(callTimer);
  const tick = () => { if (current?.startedAt) $('c-status').textContent = fmtDur(Math.round((Date.now() - current.startedAt) / 1000)); };
  tick(); callTimer = setInterval(tick, 1000);
}

function openCallUi(peerName, type) {
  muted = false; camOn = true; autoHeld = false;
  $('b-mute').classList.remove('active'); $('b-cam').classList.remove('active'); $('b-hold').classList.remove('active');
  $('c-hold').classList.add('hidden'); $('s-call').classList.remove('on-hold');
  $('local-video').style.visibility = 'visible';
  $('c-name').textContent = peerName; $('c-avatar').textContent = initials(peerName);
  $('c-quality').textContent = '';
  $('s-call').classList.toggle('is-video', type === 'video');
  $('s-call').classList.remove('video-on', 'controls-hidden', 'is-sip'); clearTimeout(hideT);
  $('local-video').classList.remove('back');
  show('s-call');
  if (native) Native.startCall({ video: type === 'video', name: peerName }).catch(() => {});
  resetVideoLayout(type === 'video');
  setSpeaker(type === 'video' || pref('speakerDefault', false));
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
  if (native) Native.endCall({ keepService: pref('ringClosed', true) }).catch(() => {});
  document.body.classList.remove('pip');
  $('remote-video').srcObject = null; $('remote-audio').srcObject = null; $('local-video').srcObject = null;
  current = null;
  $('dtmf').classList.add('hidden'); $('s-call').classList.remove('is-sip');
  logFinal(s);
  if (why) toast(why);
  show(me ? homeScreen() : 's-login');
}

$('b-end').addEventListener('click', () => current?.hangup());

// ----- Hold: manual button, and automatic while a normal phone call is going on -----
let autoHeld = false;
function renderHold() {
  if (current) {
    const mine = !!current.held, theirs = !!current.peerHeld;
    $('b-hold').classList.toggle('active', mine);
    $('b-hold').querySelector('span').textContent = mine ? 'Resume' : 'Hold';
    const tag = mine ? (autoHeld ? '⏸ On hold — you are on a phone call' : '⏸ You put the call on hold')
      : theirs ? `⏸ ${current.peer.name} put you on hold` : '';
    $('c-hold').textContent = tag; $('c-hold').classList.toggle('hidden', !tag);
    $('s-call').classList.toggle('on-hold', mine || theirs);
  }
  if (conf) {
    $('cf-hold').textContent = conf.held ? '⏸ On hold — you are on a phone call' : '';
    $('cf-hold').classList.toggle('hidden', !conf.held);
    $('s-conf').classList.toggle('on-hold', !!conf.held);
  }
}
function replayMedia() {
  document.querySelectorAll('#s-call video, #s-call audio, #s-conf video, #s-conf audio, #mini-video').forEach((m) => { if (m.srcObject && m.paused) m.play().catch(() => {}); });
}
$('b-hold').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!current) return;
  autoHeld = false;
  await current.hold(!current.held, 'hold');
  if (!current.held) replayMedia();
  renderHold();
});
if (native) {
  Native.addListener('interruption', async ({ state }) => {
    if (state === 'begin') {
      if (current && !current.held) { autoHeld = true; await current.hold(true, 'phone'); }
      if (conf && !conf.held) { autoHeld = true; conf.setHeld(true); }
      if (current || conf) toast('FitX call on hold while you are on a phone call', 3500);
      renderHold();
    } else if (state === 'end' && autoHeld) {
      autoHeld = false;
      await Native.resumeAudio({ speaker: current ? speakerOn : cfSpeaker }).catch(() => {});
      if (current && current.held) await current.hold(false);
      if (conf && conf.held) conf.setHeld(false);
      replayMedia();
      setTimeout(replayMedia, 1500);
      if (current || conf) toast('FitX call resumed');
      renderHold();
    }
  });
}
$('b-mute').addEventListener('click', () => { muted = !muted; current?.setMuted(muted); $('b-mute').classList.toggle('active', muted); });
$('b-speaker').addEventListener('click', () => setSpeaker(!speakerOn));
$('b-cam').addEventListener('click', () => { camOn = !camOn; current?.setCamera(camOn); $('b-cam').classList.toggle('active', !camOn); $('local-video').style.visibility = camOn ? 'visible' : 'hidden'; });
$('b-flip').addEventListener('click', async () => {
  try { const f = await current?.flipCamera(); $('local-video').srcObject = current.local; $('local-video').classList.toggle('back', f === 'environment'); }
  catch (e) { toast('Could not switch camera'); }
});

// ---------- Dial pad: SIP + phone (SIM) dialer ----------
let sipIncoming = null;
const sip = new SipPhone({
  isBusy: () => !!current || !!incoming || !!sipIncoming || !!conf || !!confIncoming,
  onStatus: (state, text) => {
    $('dp-status').className = 'dp-status ' + state;
    $('sip-state').textContent = state === 'off' && !loadSip().user ? 'SIP not set up — tap to set up' : text;
    $('sip-status-text').textContent = text;
  },
  onIncoming: (call) => {
    sipIncoming = call;
    call.hooks = {
      onEnded: () => {
        if (sipIncoming !== call) return;
        sipIncoming = null; Tone.stop();
        if (native) { Native.cancelIncoming().catch(() => {}); Native.showMissed({ callId: call.id, fromName: call.peer.name, callType: 'audio' }).catch(() => {}); }
        toast(`Missed SIP call from ${call.peer.name}`);
        logFinal(call);
        show(homeScreen());
      },
    };
    $('in-name').textContent = call.peer.name;
    $('in-avatar').textContent = '#';
    $('in-type').textContent = 'Incoming SIP call';
    show('s-incoming');
    (native ? Native.ringIncoming({ callId: call.id, fromName: call.peer.name, callType: 'audio' }).then((r) => r.shown) : Promise.resolve(false))
      .catch(() => false).then((shown) => { if (!shown && sipIncoming === call) Tone.ring(); });
  },
});

async function acceptSip() {
  const call = sipIncoming; if (!call) return;
  sipIncoming = null;
  Tone.stop(); if (native) Native.cancelIncoming().catch(() => {});
  current = call;
  call.hooks = hooks();
  openCallUi(call.peer.name, 'audio');
  $('s-call').classList.add('is-sip');
  $('c-avatar').textContent = '#';
  $('c-status').textContent = 'Connecting…';
  try { await call.answer(); } catch (e) { call.finish('Could not answer'); }
}
function declineSip() {
  const call = sipIncoming; if (!call) return;
  sipIncoming = null; Tone.stop(); if (native) Native.cancelIncoming().catch(() => {});
  call.hooks = {}; call.decline(); logFinal(call); show(homeScreen());
}

const cleanNum = (v) => String(v || '').replace(/[^\d+*#]/g, '');
async function dialSip(number) {
  const num = cleanNum(number);
  if (!num) return toast('Enter a number');
  if (current) return toast('Already in a call');
  if (!sip.ready()) {
    toast(loadSip().user ? 'SIP is not connected yet — check Settings' : 'Set up your SIP account in Settings first', 3500);
    return;
  }
  let call;
  try { call = await sip.call(num); } catch (e) { return toast(e.message || 'Could not call'); }
  current = call;
  call.hooks = hooks();
  openCallUi(num, 'audio');
  $('s-call').classList.add('is-sip');
  $('c-avatar').textContent = '#';
  $('c-status').textContent = 'Calling…';
  Tone.ringback();
}
async function dialGsm(number) {
  const num = cleanNum(number);
  if (!num) return toast('Enter a number');
  if (native) {
    try { await Native.dialPhone({ number: num, direct: pref('directDial', false) }); }
    catch (e) { return toast('No phone app on this device'); }
  } else location.href = 'tel:' + num;
  if (me) writeLog(me.uid, 'gsm-' + Date.now().toString(36), { peerUid: 'tel:' + num, peerName: num, number: num, dir: 'out', type: 'phone', status: 'dialed', createdAtMs: Date.now() });
}

// Keypad
const DTMF = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477], 7: [852, 1209], 8: [852, 1336], 9: [852, 1477], '*': [941, 1209], 0: [941, 1336], '#': [941, 1477] };
const keyTone = (k) => { try { Tone._beep(DTMF[k] || [941, 1336], 0.12, 0.06); } catch (e) {} if (navigator.vibrate) navigator.vibrate(12); };
const dpIn = $('dp-input');
function dpSet(v) { dpIn.value = v; }
let pressT = null, longDone = false;
$('dp-grid').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  longDone = false;
  if (b.dataset.k === '0') pressT = setTimeout(() => { longDone = true; dpSet(dpIn.value + '+'); if (navigator.vibrate) navigator.vibrate(25); }, 550);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('dp-grid').addEventListener(ev, () => clearTimeout(pressT)));
$('dp-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (!b) return;
  if (longDone) { longDone = false; return; }
  keyTone(b.dataset.k);
  dpSet(dpIn.value + b.dataset.k);
});
let backT = null;
$('dp-back').addEventListener('click', () => dpSet(dpIn.value.slice(0, -1)));
$('dp-back').addEventListener('pointerdown', () => { backT = setTimeout(() => dpSet(''), 600); });
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('dp-back').addEventListener(ev, () => clearTimeout(backT)));
dpIn.addEventListener('input', () => { const c = cleanNum(dpIn.value); if (c !== dpIn.value) dpIn.value = c; });
$('dp-sip').addEventListener('click', () => dialSip(dpIn.value));
$('dp-gsm').addEventListener('click', () => dialGsm(dpIn.value));
$('dp-status').addEventListener('click', () => {
  document.querySelector('.tabs button[data-tab="settings"]').click();
  setTimeout(() => $('sip-card').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
});
function applyRoute() {
  const r = (() => { try { return localStorage.getItem('fx-route') || 'both'; } catch (e) { return 'both'; } })();
  $('dp-sip').classList.toggle('hidden', r === 'gsm');
  $('dp-gsm').classList.toggle('hidden', r === 'sip');
  document.querySelectorAll('[data-route] [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === r));
}
document.querySelector('[data-route]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  try { localStorage.setItem('fx-route', b.dataset.v); } catch (x) {}
  applyRoute();
});
applyRoute();

// In-call keypad (DTMF) for SIP calls: "press 1 for sales…"
$('b-keys').addEventListener('click', (e) => { e.stopPropagation(); $('dtmf-show').textContent = ''; $('dtmf').classList.remove('hidden'); });
$('dtmf-close').addEventListener('click', () => $('dtmf').classList.add('hidden'));
$('dtmf-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (!b || !current || current.kind !== 'sip') return;
  keyTone(b.dataset.k);
  current.sendDTMF(b.dataset.k);
  $('dtmf-show').textContent = ($('dtmf-show').textContent + b.dataset.k).slice(-16);
});

// SIP settings
const SIP_FIELDS = { user: 'sip-user', password: 'sip-pass', domain: 'sip-domain', wss: 'sip-wss', name: 'sip-name', authUser: 'sip-auth', prefix: 'sip-prefix' };
function fillSipForm() {
  const c = loadSip();
  Object.entries(SIP_FIELDS).forEach(([k, id]) => { $(id).value = c[k] || ''; });
  $('sip-enabled').checked = !!c.enabled;
  $('opt-direct').checked = pref('directDial', false);
}
function readSipForm() {
  const c = loadSip();
  Object.entries(SIP_FIELDS).forEach(([k, id]) => { c[k] = $(id).value.trim(); });
  if (c.domain && !c.wss) c.wss = `wss://${c.domain}:8089/ws`;
  return c;
}
$('sip-save').addEventListener('click', () => {
  const c = readSipForm();
  if (!c.user || !c.domain || !c.password) return toast('Fill in username, password and domain', 3500);
  c.enabled = true;
  saveSip(c); fillSipForm();
  sip.start(c);
  toast('Connecting to SIP…');
});
$('sip-enabled').addEventListener('change', (e) => {
  const c = readSipForm();
  c.enabled = e.target.checked;
  saveSip(c);
  if (c.enabled) {
    if (!c.user || !c.domain || !c.password) { toast('Fill in your SIP details below, then tap Save & connect', 3500); $('sip-user').focus(); }
    sip.start(c);
  } else sip.stop();
});
$('opt-direct').addEventListener('change', (e) => setPref('directDial', e.target.checked));
fillSipForm();

// ---------- Use the app during a call (message, browse) ----------
let callBarT = null;
function onCallScreen(id) { return id === 's-call' || id === 's-conf' || id === 's-incoming'; }
function minimizeCall() {
  if (!current && !conf) return;
  show(chat.isOpenAny() ? 's-chat' : 's-main');
}
function restoreCall() {
  if (current) show('s-call'); else if (conf) show('s-conf');
}
function updateCallBar(id) {
  const active = !!(current || conf);
  const showBar = active && !onCallScreen(id) && !!me;
  $('callbar').classList.toggle('hidden', !showBar);
  document.body.classList.toggle('oncall', showBar);
  // floating video of the other person while browsing during a 1:1 video call
  const mv = $('mini-video');
  const vid = showBar && current && current.type === 'video' && current.remote && current.remote.getVideoTracks().length;
  if (vid) { if (mv.srcObject !== current.remote) mv.srcObject = current.remote; mv.play && mv.play().catch(() => {}); }
  else if (mv.srcObject) mv.srcObject = null;
  mv.classList.toggle('hidden', !vid);
  clearInterval(callBarT);
  if (showBar) { tickCallBar(); callBarT = setInterval(tickCallBar, 1000); }
}
function tickCallBar() {
  let name = '', t0 = null;
  if (current) { name = current.peer ? current.peer.name : 'Call'; t0 = current.startedAt; }
  else if (conf) { name = 'Group call'; t0 = conf.startedAt; }
  else return updateCallBar('');
  $('callbar-text').textContent = `${name} · ${t0 ? fmtDur(Math.round((Date.now() - t0) / 1000)) : 'Calling…'} — tap to return`;
}
$('callbar').addEventListener('click', restoreCall);
$('mini-video').addEventListener('click', restoreCall);
$('b-min').addEventListener('click', (e) => { e.stopPropagation(); minimizeCall(); });
$('cf-min').addEventListener('click', minimizeCall);
$('b-msg').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!current || current.kind === 'sip') return;
  const u = users.find((x) => x.uid === current.peer.uid) || current.peer;
  chat.openWith({ uid: u.uid, name: u.name });
});
$('cf-msg').addEventListener('click', () => {
  show('s-main');
  document.querySelector('.tabs button[data-tab="chats"]').click();
});

// ---------- Group calls (conference) ----------
let conf = null, confIncoming = null, pendingConf = null, confTimer = null, cfMuted = false, cfSpeaker = true, cfCam = true;
const confCtx = () => ({ db, me, sip, toast, onUpdate: renderConf, onEnded: endConfUi });

// People picker
let pk = { mode: 'create', sel: new Set() };
function openPicker(mode) {
  pk = { mode, sel: new Set() };
  const adding = mode === 'add';
  $('pk-title').textContent = adding ? 'Add to group call' : 'Start a group call';
  $('pk-voice').classList.toggle('hidden', adding);
  $('pk-video').classList.toggle('hidden', adding);
  $('pk-invite').classList.toggle('hidden', !adding);
  $('pk-tabs').classList.toggle('hidden', !(adding && conf && conf.isHost));
  showPkTab('team');
  $('pk-number').value = '';
  renderPicker();
  $('picker').classList.remove('hidden');
}
function closePicker() { $('picker').classList.add('hidden'); }
function showPkTab(t) {
  document.querySelectorAll('#pk-tabs [data-pt]').forEach((b) => b.classList.toggle('on', b.dataset.pt === t));
  $('pk-team').classList.toggle('hidden', t !== 'team');
  $('pk-phone').classList.toggle('hidden', t !== 'phone');
  $('pk-actions').classList.toggle('hidden', t !== 'team');
}
function pickerLimit() {
  if (pk.mode === 'add' && conf) {
    const max = conf.type === 'video' ? MAX_VIDEO : MAX_VOICE;
    return Math.max(0, max - (conf.data.joined || []).length - (conf.data.invited || []).length - conf.legs.size);
  }
  return MAX_VOICE - 1;
}
function renderPicker() {
  const taken = new Set(pk.mode === 'add' && conf ? [...(conf.data.joined || []), ...(conf.data.invited || [])] : []);
  const list = users.filter((u) => !taken.has(u.uid)).sort((a, b) => (isOnline(b) - isOnline(a)) || (a.name || '').localeCompare(b.name || ''));
  const lim = pickerLimit();
  $('pk-hint').textContent = pk.mode === 'add'
    ? (lim ? `You can add ${lim} more.` : 'The group call is full.')
    : `Pick up to ${MAX_VOICE - 1} people for voice, or ${MAX_VIDEO - 1} for video.`;
  $('pk-list').innerHTML = list.length ? list.map((u) => {
    const sel = pk.sel.has(u.uid);
    const off = !sel && pk.sel.size >= lim;
    return `<li data-pk="${u.uid}" class="${sel ? 'sel' : ''} ${off ? 'off' : ''}">
      <div class="avatar ${isOnline(u) ? 'on' : ''}">${esc(initials(u.name))}</div>
      <div class="who"><b>${esc(u.name)}</b><small>${esc(u.department || '@' + u.username)}${isOnline(u) ? ' · online' : ''}</small></div>
      <span class="ck">${sel ? '✓' : ''}</span></li>`;
  }).join('') : '<li class="empty">Nobody else to add</li>';
  $('pk-voice').textContent = ''; $('pk-voice').innerHTML = `<svg><use href="#i-phone"/></svg> Voice${pk.sel.size ? ` (${pk.sel.size + 1})` : ''}`;
  $('pk-video').innerHTML = `<svg><use href="#i-video"/></svg> Video${pk.sel.size ? ` (${pk.sel.size + 1})` : ''}`;
  $('pk-invite').textContent = pk.sel.size ? `Add ${pk.sel.size} to call` : 'Add to call';
}
$('pk-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-pk]'); if (!li) return;
  const id = li.dataset.pk;
  if (pk.sel.has(id)) pk.sel.delete(id); else pk.sel.add(id);
  renderPicker();
});
$('pk-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-pt]'); if (b) showPkTab(b.dataset.pt); });
$('pk-close').addEventListener('click', closePicker);
$('picker').addEventListener('click', (e) => { if (e.target.id === 'picker') closePicker(); });
$('group-btn').addEventListener('click', () => {
  if (current || conf) return toast('You are already in a call');
  openPicker('create');
});
const pickedUsers = () => users.filter((u) => pk.sel.has(u.uid));
$('pk-voice').addEventListener('click', () => startConf('audio'));
$('pk-video').addEventListener('click', () => startConf('video'));
$('pk-invite').addEventListener('click', async () => {
  if (!conf || !pk.sel.size) return;
  try { await conf.invite(pickedUsers()); closePicker(); toast('Calling…'); } catch (e) { toast(e.message || 'Could not add'); }
});
$('pk-dial').addEventListener('click', async () => {
  const num = cleanNum($('pk-number').value);
  if (!num) return toast('Enter a phone number');
  try { await conf.addNumber(num); closePicker(); toast(`Calling ${num}…`); } catch (e) { toast(e.message || 'Could not call', 3500); }
});

async function startConf(type) {
  const inv = pickedUsers();
  if (!inv.length) return toast('Pick at least one person');
  if (type === 'video' && inv.length > MAX_VIDEO - 1) return toast(`Video group calls: max ${MAX_VIDEO} people (you + ${MAX_VIDEO - 1})`, 3500);
  if (!navigator.onLine) return toast('No internet connection');
  closePicker();
  openConfUi(type, 'Group call');
  try { conf = await Conference.create(confCtx(), { type, invitees: inv }); confJoined(); }
  catch (e) { console.warn(e); endConfUi(e && e.name === 'NotAllowedError' ? 'Allow microphone/camera permission' : (e.message || 'Could not start the group call')); }
}
async function joinConf(id) {
  openConfUi('audio', 'Joining…');
  try { const c = new Conference(confCtx(), id); conf = c; await c.join(); $('s-conf').classList.toggle('cf-video', c.type === 'video'); confJoined(); }
  catch (e) { conf = null; endConfUi(e && e.name === 'NotAllowedError' ? 'Allow microphone/camera permission' : (e.message || 'Could not join')); }
}
function openConfUi(type, title) {
  cfMuted = false; cfCam = true; cfSpeaker = true;
  $('cf-mute').classList.remove('active'); $('cf-cam').classList.remove('active'); $('cf-speaker').classList.add('active');
  $('s-conf').classList.toggle('cf-video', type === 'video');
  $('conf-title').textContent = title;
  $('conf-time').textContent = 'Connecting…';
  $('conf-grid').innerHTML = '';
  tiles.clear();
  show('s-conf');
  if (native) { Native.startCall({ video: type === 'video', name: 'FitX group call' }).catch(() => {}); Native.setSpeaker({ on: true }).catch(() => {}); }
}
function confJoined() {
  if (!conf) return;
  if (native) Native.callConnected({ startedAt: conf.startedAt }).catch(() => {});
  clearInterval(confTimer);
  confTimer = setInterval(() => { if (conf && conf.startedAt) $('conf-time').textContent = fmtDur(Math.round((Date.now() - conf.startedAt) / 1000)); }, 1000);
  renderConf(conf);
}

// Tiles (kept between renders so videos don't flicker)
const tiles = new Map();
function tileFor(key, build) {
  let t = tiles.get(key);
  if (!t) { t = build(); tiles.set(key, t); }
  return t;
}
function mediaTile(key, name, stream, { me: isMe = false, video = false } = {}) {
  const t = tileFor(key, () => {
    const el = document.createElement('div'); el.className = 'tile';
    el.innerHTML = `<div class="avatar">${esc(initials(name))}</div><div class="nm"></div><div class="st"></div>`;
    if (video) { const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = isMe; if (isMe) v.className = 'me'; el.prepend(v); }
    else if (!isMe) { const a = document.createElement('audio'); a.autoplay = true; el.append(a); }
    return el;
  });
  const m = t.querySelector('video, audio');
  if (m && stream && m.srcObject !== stream) { m.srcObject = stream; m.play && m.play().catch(() => {}); }
  t.classList.toggle('has-video', video && !!stream && stream.getVideoTracks().length > 0);
  return t;
}
function renderConf(c) {
  if (!c || c !== conf) return;
  const d = c.data || {};
  const names = d.names || {};
  const isVideo = c.type === 'video';
  const order = [];
  // me
  const meT = mediaTile('me', me.name, isVideo ? c.local : null, { me: true, video: isVideo });
  meT.querySelector('.nm').textContent = 'You' + (c.isHost ? ' (host)' : '');
  meT.querySelector('.st').textContent = cfMuted ? 'Muted' : '';
  order.push(meT);
  // connected / connecting participants
  for (const uid of (d.joined || [])) {
    if (uid === me.uid) continue;
    const p = c.peers.get(uid);
    const t = mediaTile('u:' + uid, names[uid] || 'Employee', p ? p.stream : null, { video: isVideo });
    t.querySelector('.nm').textContent = (names[uid] || 'Employee') + (uid === d.host ? ' (host)' : '');
    t.querySelector('.st').textContent = !p ? 'Joining…' : p.state === 'connected' ? '' : p.state === 'failed' ? 'Connection problem' : p.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
    t.classList.remove('waiting');
    order.push(t);
  }
  // invited, still ringing
  for (const uid of (d.invited || [])) {
    const t = tileFor('i:' + uid, () => { const el = document.createElement('div'); el.className = 'tile waiting'; el.innerHTML = `<div class="avatar">${esc(initials(names[uid] || '?'))}</div><div class="nm">${esc(names[uid] || 'Employee')}</div><div class="st">Ringing…</div>`; return el; });
    order.push(t);
  }
  // outside phone numbers (host's SIP legs, or listed in the conference doc for others)
  const ext = c.isHost ? [...c.legs.entries()].map(([id, l]) => ({ id, number: l.number, status: l.status })) : (d.ext || []).map((x, i) => ({ id: 'e' + i, ...x }));
  for (const x of ext) {
    const t = tileFor('x:' + x.id, () => {
      const el = document.createElement('div'); el.className = 'tile ext';
      el.innerHTML = `<div class="avatar">☎</div><div class="nm"></div><div class="st"></div>${c.isHost ? `<button class="x" data-leg="${x.id}" aria-label="Hang up">✕</button>` : ''}`;
      return el;
    });
    t.querySelector('.nm').textContent = x.number;
    t.querySelector('.st').textContent = x.status === 'connected' ? 'Phone · connected' : x.status === 'ringing' ? 'Ringing…' : 'Calling…';
    order.push(t);
  }
  // drop tiles no longer present
  const keep = new Set(order);
  for (const [k, el] of tiles) if (!keep.has(el)) { el.querySelectorAll('video,audio').forEach((m) => { m.srcObject = null; }); el.remove(); tiles.delete(k); }
  const grid = $('conf-grid');
  order.forEach((el, i) => { if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null); });
  grid.className = `conf-grid ${isVideo ? 'video' : 'voice'} n${order.length}`;
  const inCall = 1 + (d.joined || []).filter((u) => u !== me.uid).length + ext.filter((x) => x.status === 'connected').length;
  $('conf-title').textContent = `Group ${isVideo ? 'video' : 'voice'} call · ${inCall} in call`;
  $('cf-end').querySelector('span').textContent = c.isHost ? 'End' : 'Leave';
  renderHold();
}
$('conf-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-leg]'); if (b && conf) conf.hangupLeg(b.dataset.leg); });

function endConfUi(why) {
  const c = conf;
  conf = null;
  clearInterval(confTimer);
  for (const [, el] of tiles) el.querySelectorAll('video,audio').forEach((m) => { m.srcObject = null; });
  tiles.clear(); $('conf-grid').innerHTML = '';
  closePicker();
  if (native) Native.endCall({ keepService: pref('ringClosed', true) }).catch(() => {});
  if (c && c.startedAt && me) {
    const names = Object.entries((c.data && c.data.names) || {}).filter(([u]) => u !== me.uid).map(([, n]) => n);
    writeLog(me.uid, 'conf-' + c.id, { peerUid: 'conf:' + c.id, peerName: 'Group: ' + (names.slice(0, 3).join(', ') || 'call') + (names.length > 3 ? ` +${names.length - 3}` : ''),
      dir: c.isHost ? 'out' : 'in', type: 'conf', media: c.type, status: 'answered', duration: Math.round(((c.endedAt || Date.now()) - c.startedAt) / 1000), createdAtMs: c.startedAt });
  }
  if (why) toast(why);
  if (me) show(homeScreen());
}

$('cf-mute').addEventListener('click', () => { if (!conf) return; cfMuted = !cfMuted; conf.setMuted(cfMuted); $('cf-mute').classList.toggle('active', cfMuted); renderConf(conf); });
$('cf-speaker').addEventListener('click', () => { cfSpeaker = !cfSpeaker; $('cf-speaker').classList.toggle('active', cfSpeaker); if (native) Native.setSpeaker({ on: cfSpeaker }).catch(() => {}); });
$('cf-cam').addEventListener('click', () => { if (!conf) return; cfCam = !cfCam; conf.setCamera(cfCam); $('cf-cam').classList.toggle('active', !cfCam); });
$('cf-add').addEventListener('click', () => { if (conf) openPicker('add'); });
$('cf-end').addEventListener('click', async () => {
  if (!conf) return;
  const c = conf;
  if (c.isHost && ((c.data.joined || []).length > 2 || c.legs.size)) {
    if (!confirm('End the group call for everyone?')) return;
  }
  await c.leave(c.isHost);
});

// Incoming group-call invites
function watchConfInvites() {
  unsubs.push(onSnapshot(query(collection(db, 'confs'), where('invited', 'array-contains', me.uid)), (snap) => {
    snap.docChanges().forEach((ch) => {
      const d = ch.doc.data(); const id = ch.doc.id;
      if (ch.type === 'added' && d.status === 'active' && Date.now() - (d.createdAtMs || 0) < 3 * 3600000) {
        if (pendingConf === id) { pendingConf = null; joinConf(id); return; }
        if (current || conf || incoming || sipIncoming || (confIncoming && confIncoming.id !== id)) return;
        showConfIncoming(id, d);
      }
      if (ch.type === 'removed' && confIncoming && confIncoming.id === id && !confIncoming.accepting) {
        confIncoming = null; Tone.stop();
        if (native) Native.cancelIncoming().catch(() => {});
        toast(`Missed group call from ${d.hostName || 'a colleague'}`);
        show(homeScreen());
      }
    });
  }, (e) => console.warn('conf invites', e)));
}
function showConfIncoming(id, d) {
  confIncoming = { id, data: d };
  const n = (d.joined || []).length + (d.invited || []).length;
  $('in-name').textContent = d.hostName || 'Group call';
  $('in-avatar').innerHTML = '<svg style="width:46px;height:46px"><use href="#i-group"/></svg>';
  $('in-type').textContent = `Group ${d.type === 'video' ? 'video' : 'voice'} call · ${n} people`;
  show('s-incoming');
  (native ? Native.ringIncoming({ callId: 'conf:' + id, fromName: `${d.hostName || 'FitX'} (group)`, callType: d.type }).then((r) => r.shown) : Promise.resolve(false))
    .catch(() => false).then((shown) => { if (!shown && confIncoming && confIncoming.id === id) Tone.ring(); });
}
function acceptConf() {
  if (!confIncoming) return;
  const id = confIncoming.id; confIncoming.accepting = true; confIncoming = null;
  Tone.stop(); if (native) Native.cancelIncoming().catch(() => {});
  joinConf(id);
}
function declineConf() {
  if (!confIncoming) return;
  const id = confIncoming.id; confIncoming = null;
  Tone.stop(); if (native) Native.cancelIncoming().catch(() => {});
  updateDoc(doc(db, 'confs', id), { invited: arrayRemove(me.uid) }).catch(() => {});
  show(homeScreen());
}

// ---------- Incoming ----------
function watchIncoming() {
  const q = query(collection(db, 'calls'), where('to', '==', me.uid), where('status', '==', 'ringing'));
  unsubs.push(onSnapshot(q, (snap) => {
    snap.docChanges().forEach((ch) => {
      const d = ch.doc.data(); const id = ch.doc.id;
      if (ch.type === 'added') {
        const age = Date.now() - (ms(d.createdAt) || d.createdAtMs || 0);
        if (age > 60000) return; // stale
        if (current || conf || confIncoming || (incoming && incoming.id !== id)) {
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
          toast(`Missed call from ${d.fromName}`); show(homeScreen());
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
  show(homeScreen());
  await updateDoc(ref, { status: 'declined', endedAt: serverTimestamp(), endedBy: me.uid }).catch(() => {});
}
$('in-accept').addEventListener('click', () => (confIncoming ? acceptConf() : sipIncoming ? acceptSip() : acceptIncoming()));
$('in-decline').addEventListener('click', () => (confIncoming ? declineConf() : sipIncoming ? declineSip() : declineIncoming()));

// ---------- Notification taps: fitxcall://call?id=...&action=answer|decline|open ----------
function handleLink(url) {
  if (!url || !url.startsWith('fitxcall://')) return;
  const u = new URL(url.replace('fitxcall://', 'https://x/'));
  const id = u.searchParams.get('id'); const action = u.searchParams.get('action') || 'open';
  if (!id) return;
  if (id.startsWith('conf:')) {
    if (confIncoming && 'conf:' + confIncoming.id === id) { if (action === 'answer') acceptConf(); else if (action === 'decline') declineConf(); }
    else if (action === 'answer') pendingConf = id.slice(5);
    return;
  }
  if (sipIncoming && sipIncoming.id === id) {
    if (action === 'answer') acceptSip(); else if (action === 'decline') declineSip();
    return;
  }
  if (incoming && incoming.id === id) {
    if (action === 'answer') acceptIncoming();
    else if (action === 'decline') declineIncoming();
  } else pendingLink = { id, action };
}
if (native) {
  App.addListener('appUrlOpen', (e) => handleLink(e.url));
  App.getLaunchUrl().then((r) => r && handleLink(r.url)).catch(() => {});
  App.addListener('backButton', () => {
    if (incoming || sipIncoming || confIncoming) return; // ringing: answer or decline
    if (current || conf) {                                  // in a call: back never hangs up
      if (!$('picker').classList.contains('hidden')) return closePicker();
      if (!$('dtmf').classList.contains('hidden')) return $('dtmf').classList.add('hidden');
      if (!$('s-call').classList.contains('hidden') || !$('s-conf').classList.contains('hidden')) return minimizeCall();
      if (chat.viewerOpen()) return chat.closeViewer();
      if (chat.isOpen()) return chat.close();
      return restoreCall();
    }
    if (!$('dtmf').classList.contains('hidden')) { $('dtmf').classList.add('hidden'); return; }
    if (chat.viewerOpen()) return chat.closeViewer();
    if (chat.isOpen()) return chat.close();
    const onTeam = !$('tab-contacts').classList.contains('hidden');
    if (!onTeam) document.querySelector('.tabs button[data-tab="contacts"]').click();
    else App.minimizeApp();
  });
  App.addListener('appStateChange', ({ isActive }) => {
    inBackground = !isActive;
    if (isActive) {
      ping(); refreshChecks(); chat.resume();
      if ((incoming || sipIncoming || confIncoming) && !current && !conf) { Native.cancelIncoming().catch(() => {}); if (!Tone.timer) Tone.ring(); }
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
