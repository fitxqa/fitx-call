// FitX Call — app shell: login, team list, recents, admin, ringing
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from 'firebase/auth';
import {
  getFirestore, doc, getDoc, updateDoc, collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { App } from '@capacitor/app';
import { CallSession } from './call.js';

const CFG = window.FITX_CONFIG || {};
const $ = (id) => document.getElementById(id);
const native = Capacitor.isNativePlatform();
const AudioRoute = registerPlugin('AudioRoute');
const VERSION = '1.0';

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

// ---------- Tones (no audio files = lighter app) ----------
const Tone = {
  ctx: null, timer: null, nodes: [],
  _beep(freqs, dur, vol = 0.18) {
    const ctx = this.ctx || (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === 'suspended') ctx.resume();
    const g = ctx.createGain(); g.gain.value = vol; g.connect(ctx.destination);
    freqs.forEach((f) => {
      const o = ctx.createOscillator(); o.frequency.value = f; o.connect(g);
      o.start(); o.stop(ctx.currentTime + dur);
    });
  },
  ring() { this.stop(); const play = () => { this._beep([880, 1100], 0.35, 0.22); setTimeout(() => this._beep([880, 1100], 0.35, 0.22), 450); if (navigator.vibrate) navigator.vibrate([400, 200, 400]); }; play(); this.timer = setInterval(play, 2200); },
  ringback() { this.stop(); const play = () => { this._beep([425], 1.0, 0.08); }; play(); this.timer = setInterval(play, 4000); },
  stop() { clearInterval(this.timer); this.timer = null; if (navigator.vibrate) navigator.vibrate(0); },
};

// ---------- Firebase ----------
const configured = CFG.firebase && CFG.firebase.apiKey && !String(CFG.firebase.apiKey).startsWith('PASTE');
let fb, auth, db, fns;
if (configured) {
  fb = initializeApp(CFG.firebase);
  auth = initializeAuth(fb, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = getFirestore(fb);
  fns = getFunctions(fb, CFG.functionsRegion || 'europe-west1');
}
const DOMAIN = CFG.loginDomain || 'fitxcall.local';
const toEmail = (u) => `${String(u).trim().toLowerCase()}@${DOMAIN}`;

// ---------- State ----------
let me = null;            // { uid, name, username, role, department }
let users = [];           // team list
let current = null;       // CallSession
let incoming = null;      // { id, data }
let pendingLink = null;   // { id, action } from notification tap
let unsubs = [];
let heartbeat = null;
let callTimer = null;

// ---------- Auth ----------
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await signInWithEmailAndPassword(auth, toEmail($('login-user').value), $('login-pass').value);
  } catch (err) {
    const c = err.code || '';
    $('login-err').textContent = c.includes('invalid') || c.includes('wrong') || c.includes('not-found')
      ? 'Wrong username or password' : c.includes('disabled') ? 'This account is disabled — contact admin'
        : c.includes('network') ? 'No internet connection' : 'Sign-in failed. Try again.';
  }
  btn.disabled = false; btn.textContent = 'Sign in';
});

$('logout').addEventListener('click', async () => {
  if (!confirm('Sign out? You will not receive calls on this phone.')) return;
  try { await updateDoc(doc(db, 'users', me.uid), { fcmToken: null }); } catch (e) {}
  await signOut(auth);
});

async function onLogin(user) {
  const snap = await getDoc(doc(db, 'users', user.uid)).catch(() => null);
  if (!snap || !snap.exists() || snap.data().disabled) {
    await signOut(auth);
    show('s-login');
    $('login-err').textContent = snap && snap.exists() ? 'This account is disabled — contact admin' : 'Account not set up — contact admin';
    return;
  }
  me = { uid: user.uid, ...snap.data() };
  $('me-chip').textContent = me.name;
  $('set-name').textContent = me.name;
  $('set-user').textContent = `@${me.username}${me.department ? ' · ' + me.department : ''}${me.role === 'admin' ? ' · Admin' : ''}`;
  $('nav-admin').classList.toggle('hidden', me.role !== 'admin');
  show('s-main');
  watchTeam();
  watchIncoming();
  watchRecents();
  if (me.role === 'admin') watchAdmin();
  ping();
  heartbeat = setInterval(ping, 60000);
  setupPush();
}

function onLogout() {
  unsubs.forEach((u) => u()); unsubs = [];
  clearInterval(heartbeat);
  me = null; users = [];
  show('s-login');
}

function ping() {
  if (!me || document.hidden) return;
  updateDoc(doc(db, 'users', me.uid), { lastSeen: serverTimestamp(), appVersion: VERSION, platform: Capacitor.getPlatform() }).catch(() => {});
}
document.addEventListener('visibilitychange', ping);

// ---------- Push (ring when app closed) ----------
async function setupPush() {
  if (!native) { $('push-state').textContent = 'Only in the Android app'; return; }
  try {
    let p = await PushNotifications.checkPermissions();
    if (p.receive !== 'granted') p = await PushNotifications.requestPermissions();
    if (p.receive !== 'granted') { $('push-state').textContent = 'Notifications blocked — allow them in phone Settings'; return; }
    await PushNotifications.removeAllListeners();
    PushNotifications.addListener('registration', (t) => {
      updateDoc(doc(db, 'users', me.uid), { fcmToken: t.value }).catch(() => {});
      $('push-state').textContent = 'Ready — calls ring even when the app is closed';
    });
    PushNotifications.addListener('registrationError', () => { $('push-state').textContent = 'Push setup failed (check google-services.json)'; });
    await PushNotifications.register();
  } catch (e) {
    $('push-state').textContent = 'Push not available in this build';
  }
}

// ---------- Team ----------
function watchTeam() {
  unsubs.push(onSnapshot(collection(db, 'users'), (snap) => {
    users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => u.uid !== me.uid && !u.disabled)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderTeam();
  }));
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

// ---------- Recents ----------
let recFrom = [], recTo = [];
const recentPeers = {};
function watchRecents() {
  const base = collection(db, 'calls');
  unsubs.push(onSnapshot(query(base, where('from', '==', me.uid), orderBy('createdAt', 'desc'), limit(40)),
    (s) => { recFrom = s.docs.map((d) => ({ id: d.id, ...d.data() })); renderRecents(); }, () => {}));
  unsubs.push(onSnapshot(query(base, where('to', '==', me.uid), orderBy('createdAt', 'desc'), limit(40)),
    (s) => { recTo = s.docs.map((d) => ({ id: d.id, ...d.data() })); renderRecents(); }, () => {}));
}
function renderRecents() {
  const all = [...recFrom, ...recTo].sort((a, b) => (ms(b.createdAt) || b.createdAtMs) - (ms(a.createdAt) || a.createdAtMs)).slice(0, 50);
  $('recents').innerHTML = all.length ? all.map((c) => {
    const out = c.from === me.uid;
    const peer = out ? { uid: c.to, name: c.toName } : { uid: c.from, name: c.fromName };
    recentPeers[peer.uid] = peer;
    const missed = !out && ['missed', 'cancelled'].includes(c.status);
    const dur = c.answeredAt && c.endedAt ? fmtDur(Math.max(0, Math.round((ms(c.endedAt) - ms(c.answeredAt)) / 1000))) : '';
    const label = missed ? 'Missed' : out ? (c.status === 'declined' ? 'Declined' : c.status === 'busy' ? 'Busy' : 'Outgoing') : (c.status === 'declined' ? 'Declined' : 'Incoming');
    return `<li>
      <div class="avatar">${esc(initials(peer.name))}</div>
      <div class="who"><b>${esc(peer.name)}</b><small class="dir ${missed ? 'missed' : ''}">${out ? '↗' : '↙'} ${label} ${c.type === 'video' ? 'video' : 'voice'}${dur ? ' · ' + dur : ''} · ${ago(ms(c.createdAt) || c.createdAtMs)}</small></div>
      <button class="icon-btn" data-call="${peer.uid}" data-type="${c.type}"><svg><use href="#i-${c.type === 'video' ? 'video' : 'phone'}"/></svg></button>
    </li>`;
  }).join('') : '<li class="empty">No calls yet</li>';
}

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  ['contacts', 'recents', 'admin', 'settings'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
}));
$('opt-saver').checked = saverOn();
$('opt-saver').addEventListener('change', (e) => { try { localStorage.setItem('saver', e.target.checked ? '1' : '0'); } catch (x) {} });

// ---------- Admin ----------
const call = (name) => httpsCallable(fns, name);
function fnErr(e) { return (e && e.message ? e.message.replace(/^.*?:\s*/, '') : 'Failed') || 'Failed'; }

function watchAdmin() {
  unsubs.push(onSnapshot(collection(db, 'users'), (snap) => {
    const all = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    $('admin-list').innerHTML = all.map((u) => `
      <li>
        <div class="avatar">${esc(initials(u.name))}</div>
        <div class="who"><b>${esc(u.name)}${u.role === 'admin' ? '<span class="badge">admin</span>' : ''}${u.disabled ? '<span class="badge off">disabled</span>' : ''}</b>
          <small>@${esc(u.username)}${u.department ? ' · ' + esc(u.department) : ''}</small></div>
        <div class="actions">
          <button class="btn small" data-adm="pass" data-uid="${u.uid}">Password</button>
          ${u.uid === me.uid ? '' : `<button class="btn small" data-adm="${u.disabled ? 'enable' : 'disable'}" data-uid="${u.uid}">${u.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn small" data-adm="delete" data-uid="${u.uid}">Delete</button>`}
        </div>
      </li>`).join('');
    $('admin-list')._users = all;
  }));
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-msg'); msg.textContent = 'Creating…';
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try {
    await call('adminCreateUser')({
      name: $('a-name').value.trim(), username: $('a-user').value.trim().toLowerCase(),
      password: $('a-pass').value, department: $('a-dept').value.trim(), role: $('a-role').value,
    });
    msg.textContent = '';
    toast(`Account created — username: ${$('a-user').value.trim().toLowerCase()}`, 4000);
    e.target.reset();
  } catch (err) { msg.textContent = fnErr(err); }
  btn.disabled = false;
});

$('admin-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-adm]'); if (!b) return;
  const u = ($('admin-list')._users || []).find((x) => x.uid === b.dataset.uid); if (!u) return;
  try {
    if (b.dataset.adm === 'pass') {
      const p = prompt(`New password for ${u.name} (min 6 characters):`);
      if (!p) return;
      await call('adminUpdateUser')({ uid: u.uid, password: p });
      toast('Password changed');
    } else if (b.dataset.adm === 'disable' || b.dataset.adm === 'enable') {
      await call('adminUpdateUser')({ uid: u.uid, disabled: b.dataset.adm === 'disable' });
      toast(b.dataset.adm === 'disable' ? 'Account disabled' : 'Account enabled');
    } else if (b.dataset.adm === 'delete') {
      if (!confirm(`Delete ${u.name}'s account permanently?`)) return;
      await call('adminDeleteUser')({ uid: u.uid });
      toast('Account deleted');
    }
  } catch (err) { toast(fnErr(err)); }
});

// ---------- Calling ----------
function setSpeaker(on) {
  speakerOn = on;
  $('b-speaker').classList.toggle('active', on);
  if (native) AudioRoute.setSpeaker({ on }).catch(() => {});
}
let speakerOn = false, muted = false, camOn = true;

function hooks(peerName) {
  return {
    onRemoteStream: (stream) => {
      $('remote-audio').srcObject = stream;
      if (current?.type === 'video') { $('remote-video').srcObject = stream; $('remote-audio').srcObject = null; }
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
  $('c-name').textContent = peerName; $('c-avatar').textContent = initials(peerName);
  $('c-quality').textContent = '';
  $('s-call').classList.toggle('is-video', type === 'video');
  $('s-call').classList.remove('video-on');
  $('local-video').classList.remove('back');
  show('s-call');
  if (native) AudioRoute.startCall({ video: type === 'video' }).catch(() => {});
  setSpeaker(type === 'video');
}

async function startCall(peer, type) {
  if (current) return toast('Already in a call');
  if (!navigator.onLine) return toast('No internet connection');
  current = new CallSession({ db, me, peer, type, role: 'caller', saver: saverOn(), hooks: hooks(peer.name) });
  openCallUi(peer.name, type);
  $('c-status').textContent = 'Calling…';
  try {
    await current.start();
    if (type === 'video') $('local-video').srcObject = current.local;
    Tone.ringback();
  } catch (e) {
    console.warn(e);
    const why = e && e.name === 'NotAllowedError' ? 'Allow microphone/camera permission' : 'Could not start the call';
    current.finish(why);
  }
}

function endUi(why) {
  Tone.stop();
  clearInterval(callTimer);
  if (native) AudioRoute.endCall().catch(() => {});
  $('remote-video').srcObject = null; $('remote-audio').srcObject = null; $('local-video').srcObject = null;
  current = null;
  if (why) toast(why);
  show(me ? 's-main' : 's-login');
  clearNotifications();
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
        showIncoming(id, d);
      }
      if (ch.type === 'removed' && incoming && incoming.id === id) {
        // caller hung up / timed out / answered on another device
        if (!incoming.accepting) { Tone.stop(); incoming = null; toast(`Missed call from ${d.fromName}`); show('s-main'); clearNotifications(); }
      }
    });
  }, (err) => console.warn('incoming', err)));
}

function showIncoming(id, d) {
  incoming = { id, data: d };
  $('in-name').textContent = d.fromName;
  $('in-avatar').textContent = initials(d.fromName);
  $('in-type').textContent = d.type === 'video' ? 'Incoming HD video call' : 'Incoming HD voice call';
  show('s-incoming');
  Tone.ring();
  if (pendingLink && pendingLink.id === id) { const a = pendingLink.action; pendingLink = null; if (a === 'answer') acceptIncoming(); if (a === 'decline') declineIncoming(); }
}

async function acceptIncoming() {
  if (!incoming || incoming.accepting) return;
  incoming.accepting = true;
  Tone.stop(); clearNotifications();
  const { id, data } = incoming;
  current = new CallSession({ db, me, peer: { uid: data.from, name: data.fromName }, type: data.type, role: 'callee', callId: id, saver: saverOn(), hooks: hooks(data.fromName) });
  openCallUi(data.fromName, data.type);
  $('c-status').textContent = 'Connecting…';
  try {
    await current.accept(data);
    if (data.type === 'video') $('local-video').srcObject = current.local;
  } catch (e) {
    console.warn(e);
    current.setStatus('ended');
    current.finish(e && e.name === 'NotAllowedError' ? 'Allow microphone/camera permission' : 'Could not connect');
  }
  incoming = null;
}

async function declineIncoming() {
  if (!incoming) return;
  Tone.stop(); clearNotifications();
  const ref = doc(db, 'calls', incoming.id);
  incoming = null;
  show('s-main');
  await updateDoc(ref, { status: 'declined', endedAt: serverTimestamp(), endedBy: me.uid }).catch(() => {});
}
$('in-accept').addEventListener('click', acceptIncoming);
$('in-decline').addEventListener('click', declineIncoming);

function clearNotifications() { if (native) PushNotifications.removeAllDeliveredNotifications().catch(() => {}); }

// ---------- Notification taps: fitxcall://call?id=...&action=answer|decline|open ----------
function handleLink(url) {
  if (!url || !url.startsWith('fitxcall://')) return;
  const u = new URL(url.replace('fitxcall://', 'https://x/'));
  const id = u.searchParams.get('id'); const action = u.searchParams.get('action') || 'open';
  if (!id) return;
  if (incoming && incoming.id === id) { if (action === 'answer') acceptIncoming(); else if (action === 'decline') declineIncoming(); }
  else pendingLink = { id, action };
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
  App.addListener('resume', () => { ping(); clearNotificationsIfIdle(); });
}
function clearNotificationsIfIdle() { if (!incoming) clearNotifications(); }

window.addEventListener('online', () => toast('Back online'));
window.addEventListener('offline', () => toast('No internet connection'));

// ---------- Boot ----------
if (!configured) show('s-setup');
else onAuthStateChanged(auth, (u) => (u ? onLogin(u) : onLogout()));
