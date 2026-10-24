# FitX Call — Employee HD Voice & Video Calling

Private calling app for FitX Sports Equipment Services staff.

- **HD voice** (Opus 48 kHz wideband, up to 64 kbps, packet-loss protection) and **HD video** (720p / 30 fps, auto-adapts to the network)
- **Each employee gets their own username + password** — created by the admin inside the app
- **Rings like WhatsApp** — full-screen incoming call on the lock screen, even when the app is closed
- Mute, speaker/earpiece, camera on/off, front/back camera, call timer, live quality indicator
- Recents with missed calls, online status, search
- **Data saver** switch (360p video) for weak mobile data
- Lite: ~5 MB APK, no audio/image files, FitX black & orange design

---

## One-time setup (≈20 minutes, all doable from a phone browser)

### 1. Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** → name it `fitx-call`.
2. **Upgrade to Blaze (pay-as-you-go)** — bottom-left "Upgrade". Needed for the ringing push. For a small team this stays inside the free quota (normally QAR 0/month). Set a budget alert of $1 to be safe.
3. **Build → Authentication → Get started → Email/Password → Enable → Save.**
4. **Build → Firestore Database → Create database** → location **`europe-west1 (Belgium)`** → Production mode.
   *(The location must match `REGION` in `functions/index.js`.)*

### 2. Add the apps in Firebase (Project settings ⚙️ → General → Your apps)
1. **Web app** (`</>` icon) → nickname `fitx-call-web` → Register. Copy the config values into **`www/firebase-config.js`** (edit the file on GitHub with the ✏️ pencil).
2. **Android app** → package name **`qa.fitx.call`** → Register → **download `google-services.json`**.
   Add it to the repo at **`android/app/google-services.json`** (GitHub → Add file → Upload files), **or** paste its full text into a repo secret named `GOOGLE_SERVICES_JSON`.

### 3. Deploy the backend from GitHub
1. Firebase ⚙️ → **Service accounts** → **Generate new private key** → downloads a `.json` file.
2. Give that account permission to deploy: open <https://console.cloud.google.com/iam-admin/iam> (select the project) → find `firebase-adminsdk-…@…` → ✏️ → **Add another role → Owner** → Save.
3. In GitHub: repo → **Settings → Secrets and variables → Actions → New repository secret**:
   | Name | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | the full text of the `.json` key file |
   | `ADMIN_USERNAME` | your login, e.g. `admin` |
   | `ADMIN_PASSWORD` | your password (6+ characters) |
   | `ADMIN_NAME` | your name (optional) |
   | `FITX_KEYSTORE_B64` | app signing key (from the signing-secrets file) |
   | `FITX_KEYSTORE_PASSWORD` | signing key password (same file) |
4. **Actions → "Deploy backend (Firebase)" → Run workflow.**
   First deploy can fail once with a permissions/Eventarc message — wait 3 minutes and run it again.

### 4. Build & install the APK
- Every push to `main` builds automatically. Or: **Actions → Build APK → Run workflow**.
- When it's green: repo → **Releases** → latest → download **`FitX-Call.apk`** on the phone → install (allow "Install unknown apps").
- New versions install over the old one (same signing key).

### 5. Add employees
Sign in with your admin username → **Admin** tab → enter name, username, password, department → **Create account**.
Share the username + password with the employee. From the Admin tab you can also **change passwords, disable, or delete** accounts.

---

## Important for reliable calls

**TURN server (strongly recommended).** Calls work directly over Wi-Fi, but on 4G/5G (Ooredoo / Vodafone) some calls can't connect without a relay. Free option: create an account at <https://www.metered.ca/stun-turn>, copy the credentials into `turn: [...]` in `www/firebase-config.js`, push, and reinstall.

**Phone battery settings (each employee, once).** Settings → Apps → FitX Call → Battery → **Unrestricted**; allow **Notifications**, **Lock-screen notifications**, and on Xiaomi/Oppo/Huawei **Autostart**. Otherwise some phones block calls while the app is closed.

## How it works
- **WebRTC** peer-to-peer media (encrypted DTLS-SRTP); audio/video never pass through Firebase.
- **Firestore** = signaling (call offers/answers) + employee directory, locked down by `firestore.rules`.
- **Cloud Functions** = push to ring the callee (FCM high-priority) + admin-only account management.
- **Capacitor 8** Android wrapper with native full-screen call notification, speaker/earpiece routing and screen-off-at-ear.

## Files
| Path | What |
|---|---|
| `www/firebase-config.js` | **Your settings** (Firebase + TURN) |
| `src/app.js`, `src/call.js` | App screens + calling engine |
| `functions/index.js` | Push ringing + admin functions |
| `firestore.rules` | Security rules |
| `android/app/src/main/java/qa/fitx/call/` | Native ringing & audio routing |
| `.github/workflows/` | APK build + backend deploy |

The app signing key lives only in the GitHub secrets `FITX_KEYSTORE_B64` and `FITX_KEYSTORE_PASSWORD` — keep a backup copy; without it, new versions can't update the installed app.
