// Creates (or resets) the first admin account. Run by the "Deploy backend" GitHub workflow.
// Env: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_NAME (optional), GOOGLE_APPLICATION_CREDENTIALS
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const DOMAIN = 'fitxcall.local';

(async () => {
  const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || 'FitX Admin').trim();
  if (!username || !password) { console.log('ADMIN_USERNAME / ADMIN_PASSWORD not set — skipping admin creation'); return; }
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('ADMIN_USERNAME must be 3–30 lowercase letters, numbers, . _ -');
  if (password.length < 6) throw new Error('ADMIN_PASSWORD must be at least 6 characters');
  initializeApp();
  const email = `${username}@${DOMAIN}`;
  let user;
  try {
    user = await getAuth().getUserByEmail(email);
    await getAuth().updateUser(user.uid, { password, displayName: name, disabled: false });
    console.log(`Admin "${username}" already existed — password reset.`);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    user = await getAuth().createUser({ email, password, displayName: name });
    console.log(`Admin "${username}" created.`);
  }
  await getFirestore().doc(`users/${user.uid}`).set(
    { name, username, role: 'admin', disabled: false, department: 'Management' }, { merge: true },
  );
})().catch((e) => { console.error(e.message); process.exit(1); });
