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

  // Firestore database: the app uses "(default)" if it exists, otherwise "default".
  databaseIds: ["(default)", "default"],

  // Usernames are turned into hidden logins like  ahmed@fitxcall.local
  // (no real email is needed).
  loginDomain: "fitxcall.local",

  // TURN relay — needed for calls over mobile data (4G/5G). Use ONE of these:
  // (A) ExpressTURN (free 1000 GB/month): paste the server, username and password from your dashboard:
  //   turn: [{ urls: ["turn:SERVER:3478", "turn:SERVER:3478?transport=tcp"], username: "USER", credential: "PASSWORD" }],
  // (B) Metered Open Relay (free 20 GB/month): paste your credentials API link:
  //   turnApiUrl: "https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY",
  turn: [{
    urls: ["turn:free.expressturn.com:3478", "turn:free.expressturn.com:3478?transport=tcp"],
    username: "000000002108247908",
    credential: "SElZVXW9r6g301dwx3iKmpo5nAc="
  }],
  turnApiUrl: ""
};
