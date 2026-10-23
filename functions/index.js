// FitX Call — Cloud Functions
// 1) Rings the employee's phone (push) when a call starts, stops it when the call ends.
// 2) Admin-only account management: create / change password / disable / delete.
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const REGION = 'europe-west1';       // must match functionsRegion in www/firebase-config.js
const DOMAIN = 'fitxcall.local';     // must match loginDomain in www/firebase-config.js

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 5, memory: '256MiB' });
const db = getFirestore();

// ---------------- Ringing ----------------
async function tokenOf(uid) {
  const s = await db.doc(`users/${uid}`).get();
  return s.exists ? s.get('fcmToken') : null;
}

async function push(token, data, ttlMs) {
  if (!token) return false;
  try {
    await getMessaging().send({ token, data, android: { priority: 'high', ttl: ttlMs } });
    return true;
  } catch (e) {
    console.warn('push failed', e.code || e.message);
    return false;
  }
}

exports.onCallCreated = onDocumentCreated('calls/{callId}', async (event) => {
  const c = event.data && event.data.data();
  if (!c || c.status !== 'ringing') return;
  const ok = await push(await tokenOf(c.to), {
    type: 'call', callId: event.params.callId,
    fromName: String(c.fromName || 'FitX'), callType: String(c.type || 'audio'),
  }, 45000);
  if (ok) await event.data.ref.update({ delivered: true }).catch(() => {});
});

exports.onCallUpdated = onDocumentUpdated('calls/{callId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status !== 'ringing' || after.status === 'ringing') return;
  await push(await tokenOf(after.to), {
    type: 'call_end', callId: event.params.callId, status: String(after.status),
    fromName: String(after.fromName || 'FitX'), callType: String(after.type || 'audio'),
  }, 60000);
});

// ---------------- Admin ----------------
async function requireAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
  const s = await db.doc(`users/${req.auth.uid}`).get();
  if (!s.exists || s.get('role') !== 'admin' || s.get('disabled')) throw new HttpsError('permission-denied', 'Admins only');
}
const clean = (v, max = 60) => String(v || '').trim().slice(0, max);

exports.adminCreateUser = onCall(async (req) => {
  await requireAdmin(req);
  const name = clean(req.data.name);
  const username = clean(req.data.username, 30).toLowerCase();
  const password = String(req.data.password || '');
  const department = clean(req.data.department, 40);
  const role = req.data.role === 'admin' ? 'admin' : 'employee';
  if (!name) throw new HttpsError('invalid-argument', 'Name is required');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpsError('invalid-argument', 'Username: 3–30 lowercase letters, numbers, . _ -');
  if (password.length < 6) throw new HttpsError('invalid-argument', 'Password must be at least 6 characters');
  let user;
  try {
    user = await getAuth().createUser({ email: `${username}@${DOMAIN}`, password, displayName: name });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'That username is already taken');
    throw new HttpsError('internal', e.message);
  }
  await db.doc(`users/${user.uid}`).set({
    name, username, department, role, disabled: false,
    createdAt: FieldValue.serverTimestamp(), createdBy: req.auth.uid,
  });
  return { uid: user.uid };
});

exports.adminUpdateUser = onCall(async (req) => {
  await requireAdmin(req);
  const uid = clean(req.data.uid, 128);
  if (!uid) throw new HttpsError('invalid-argument', 'Missing user');
  const authUpd = {}, docUpd = {};
  if (req.data.password !== undefined) {
    const p = String(req.data.password);
    if (p.length < 6) throw new HttpsError('invalid-argument', 'Password must be at least 6 characters');
    authUpd.password = p;
  }
  if (req.data.name !== undefined) { docUpd.name = clean(req.data.name); authUpd.displayName = docUpd.name; }
  if (req.data.department !== undefined) docUpd.department = clean(req.data.department, 40);
  if (req.data.role !== undefined) docUpd.role = req.data.role === 'admin' ? 'admin' : 'employee';
  if (req.data.disabled !== undefined) {
    if (uid === req.auth.uid) throw new HttpsError('failed-precondition', 'You cannot disable yourself');
    docUpd.disabled = !!req.data.disabled; authUpd.disabled = !!req.data.disabled;
    if (docUpd.disabled) docUpd.fcmToken = null;
  }
  if (Object.keys(authUpd).length) await getAuth().updateUser(uid, authUpd);
  if (authUpd.disabled || authUpd.password) await getAuth().revokeRefreshTokens(uid);
  if (Object.keys(docUpd).length) await db.doc(`users/${uid}`).update(docUpd);
  return { ok: true };
});

exports.adminDeleteUser = onCall(async (req) => {
  await requireAdmin(req);
  const uid = clean(req.data.uid, 128);
  if (uid === req.auth.uid) throw new HttpsError('failed-precondition', 'You cannot delete yourself');
  await getAuth().deleteUser(uid).catch((e) => { if (e.code !== 'auth/user-not-found') throw e; });
  await db.doc(`users/${uid}`).delete();
  return { ok: true };
});
