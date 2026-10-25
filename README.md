# FitX Call — Employee HD Voice & Video Calling

Private calling app for FitX Sports Equipment Services staff. Runs on the **free Firebase Spark plan** (no billing, no card).

- **HD voice** (Opus 48 kHz wideband, up to 64 kbps, packet-loss protection) and **HD video** (720p / 30 fps, adapts to the network)
- **Each employee gets their own username + password**, created by the admin inside the app (Admin tab)
- Admin can add employees, reset passwords, disable or delete accounts; employees can change their own password
- Incoming calls ring full-screen on the lock screen, even when the app is closed
- Mute, speaker/earpiece, camera on/off, front/back camera, call timer, live quality indicator
- Recents with missed calls, online status, search, **Data saver** (360p video)
- Lite: ~4.5 MB APK, FitX black & orange design

## Setup (one time, free)

1. **Firestore:** a Standard-edition database `(default)` (europe-west1) with the rules from
   [`firestore.rules`](https://raw.githubusercontent.com/fitxqa/fitx-call/main/firestore.rules) published.
2. **Authentication:** Email/Password sign-in enabled.
3. Install **FitX-Call.apk** from **[Releases](https://github.com/fitxqa/fitx-call/releases/latest)**.
   The first person to sign in (or tap *First-time setup*) becomes the admin; then add employees in the **Admin** tab.

## In-app Settings

- **Calls & messages:** Ring when app is closed · Message notifications · Voice calls on speaker · Data saver
- **Phone permissions:** Notifications · Battery no restrictions · Show calls on lock screen · Autostart (opens the
  Xiaomi/Oppo/Vivo/Huawei/Honor page). A banner at the top says whether calls will ring.

Calls ring when the app is closed through a small background service ("Ready to receive calls" notification) that
listens natively — no paid server push needed. Calls on mobile data go through the ExpressTURN relay set in
`www/firebase-config.js`. Media in chats is stored in Firestore (free plan has no file Storage): photos are
compressed, videos ≤ 8 MB, voice ≤ 3 min, and media auto-deletes after 30 days.

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
