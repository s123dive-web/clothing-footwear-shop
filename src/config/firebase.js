// ---------------------------------------------------------------------------
// Firebase configuration for the Clothing & Footwear Shop Manager.
//
// >>> REPLACE every placeholder below with YOUR OWN Firebase project's config. <<<
// Get these values from the Firebase console:
//   Project settings → General → "Your apps" → SDK setup and configuration → Config.
//
// These client-side keys are safe to be public — access to the data is enforced by
// Firebase Authentication + the Realtime Database security rules (database.rules.json).
// Do NOT paste another project's config here, and do NOT commit real keys you want kept
// private (see firebase.example.js and the README for the setup steps).
// ---------------------------------------------------------------------------
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getStorage } from "firebase/storage";

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebasedatabase.app",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// True once the placeholders above have been replaced with a real config. The app reads
// this to show a friendly "configure Firebase" screen instead of crashing on init.
export const isFirebaseConfigured =
  !!firebaseConfig.apiKey &&
  !!firebaseConfig.databaseURL &&
  !!firebaseConfig.projectId &&
  !/YOUR_|PLACEHOLDER|xxxx/i.test(
    [firebaseConfig.apiKey, firebaseConfig.databaseURL, firebaseConfig.projectId].join("|")
  );

// Only initialise Firebase when it's actually configured, so importing this module never
// throws with placeholder values. Consumers must guard on `isFirebaseConfigured` (the app's
// root does) before touching auth/db/storage.
let app = null;
let auth = null;
let db = null;
let storage = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  storage = getStorage(app);
}

export { app, auth, db, storage };
