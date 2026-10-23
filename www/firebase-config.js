// ===================================================================
//  FitX Call — settings. Edit this ONE file with your Firebase details.
//  Firebase console → Project settings → General → Your apps → Web app
//  → "SDK setup and configuration" → Config. Copy the values below.
// ===================================================================
window.FITX_CONFIG = {
  firebase: {
    apiKey: "PASTE_API_KEY",
    authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
    projectId: "PASTE_PROJECT_ID",
    storageBucket: "PASTE_PROJECT_ID.firebasestorage.app",
    messagingSenderId: "PASTE_SENDER_ID",
    appId: "PASTE_APP_ID"
  },

  // Must match the region in functions/index.js
  functionsRegion: "europe-west1",

  // Usernames are turned into hidden logins like  ahmed@fitxcall.local
  // (no real email is needed). Must match functions/index.js
  loginDomain: "fitxcall.local",

  // OPTIONAL but strongly recommended for calls over mobile data (4G/5G):
  // a TURN relay server. Free option: https://www.metered.ca/stun-turn
  // Example:
  // turn: [{ urls: ["turn:global.relay.metered.ca:80", "turn:global.relay.metered.ca:443?transport=tcp"],
  //          username: "YOUR_USER", credential: "YOUR_PASSWORD" }]
  turn: []
};
