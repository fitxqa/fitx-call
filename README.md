# FitX Call — Employee HD Voice & Video Calling

Private calling app for FitX Sports Equipment Services staff. Runs on the **free Firebase Spark plan** (no billing, no card).

- **HD voice** (Opus 48 kHz wideband, up to 64 kbps, packet-loss protection) and **HD video** (720p / 30 fps, adapts to the network)
- **Each employee gets their own username + password**, created by the admin inside the app (Admin tab)
- Admin can add employees, reset passwords, disable or delete accounts; employees can change their own password
- Incoming calls ring with a full-screen screen on the lock screen while the app runs in the background
- Mute, speaker/earpiece, camera on/off, front/back camera, call timer, live quality indicator
- Recents with missed calls, online status, search, **Data saver** (360p video)
- Lite: ~4.5 MB APK, FitX black & orange design

## Setup (one time, free)

1. **Firebase project** — already created (`studio-1166518588-1f04b`), app files already in this repo.
2. Open **https://shell.cloud.google.com/?show=terminal** (signed in with the Google account that owns the Firebase project) and paste:
   ```
   bash <(curl -fsSL https://raw.githubusercontent.com/fitxqa/fitx-call/main/cloudshell-setup.sh)
   ```
   It turns on the database, username/password sign-in and the security rules, then asks you for your **admin username and password**.
3. Install **FitX-Call.apk** from **[Releases](https://github.com/fitxqa/fitx-call/releases/latest)** on each phone, sign in, and add employees in the **Admin** tab.

## Making calls ring reliably (free plan)

The free plan has no server push, so the app itself stays running in the background and shows a small **"Ready to receive calls"** notification.
On each phone, open **Settings** in the app and fix every ✗:
- Notifications allowed
- Battery: unrestricted
- Show calls on lock screen

Then **don't swipe FitX Call away** from recent apps (if you do, it notifies you to reopen it).
Xiaomi / Redmi / Oppo / Vivo / Huawei: also allow **Autostart** in the phone's app settings.

**Mobile data:** calls between 4G/5G phones may need a TURN relay. Free option: <https://www.metered.ca/stun-turn> — add the credentials to `turn: [...]` in `www/firebase-config.js`.

## How it works
- **WebRTC** peer-to-peer, encrypted (DTLS-SRTP). Voice/video never pass through Firebase.
- **Firestore** = call signaling, employee directory, per-user call history, protected by `firestore.rules`.
- **Firebase Auth** = username/password logins (usernames map to hidden `@fitxcall.local` logins).
- **Capacitor 8** Android app with a foreground service, native full-screen ringing, speaker/earpiece routing and screen-off-at-ear.

## Files
| Path | What |
|---|---|
| `www/firebase-config.js` | Firebase + TURN settings |
| `src/app.js`, `src/call.js` | App screens + calling engine |
| `firestore.rules` | Security rules (published by the setup script) |
| `cloudshell-setup.sh` | Free one-command setup |
| `android/app/src/main/java/qa/fitx/call/` | Background service, ringing, audio routing |
| `.github/workflows/build-apk.yml` | Builds the signed APK on every push |

The APK signing key lives only in the GitHub secret `FITX_ALL` — keep a backup of FitX-Call-Secret.txt; without it, new versions can't update the installed app.
