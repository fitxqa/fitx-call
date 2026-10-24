// ===================================================================
//  FitX Call — settings. Edit this ONE file with your Firebase details.
//  Firebase console → Project settings → General → Your apps → Web app
//  → "SDK setup and configuration" → Config. Copy the values below.
// ===================================================================
window.FITX_CONFIG = {
  firebase: {
    apiKey: "AIzaSyCPWg3BlHP6d4RDUySPDP-9gASpR6I37PM",
    authDomain: "studio-1166518588-1f04b.firebaseapp.com",
    projectId: "studio-1166518588-1f04b",
    storageBucket: "studio-1166518588-1f04b.firebasestorage.app",
    messagingSenderId: "455163319161",
    appId: "1:455163319161:android:34930a36b5b99edb3855a8"
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
