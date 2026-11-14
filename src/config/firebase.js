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
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator } from "firebase/database";
import { getStorage, connectStorageEmulator } from "firebase/storage";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyDkfM9RhnBD1XIxXkQHVXc4EJB57Xsetas",
  authDomain: "vijayclothingfootwareshop.firebaseapp.com",
  databaseURL: "https://vijayclothingfootwareshop-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "vijayclothingfootwareshop",
  storageBucket: "vijayclothingfootwareshop.firebasestorage.app",
  messagingSenderId: "1078004959031",
  appId: "1:1078004959031:web:527c6bac23854485a1bcb2",
  measurementId: "G-TM4M005MED"
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

// ---------------------------------------------------------------------------
// Emulator switch (dev / automated tests ONLY — never the live shop).
//
// On when BOTH hold:  VITE_FIREBASE_EMULATOR=1  (set by .env.emulator, i.e. `vite --mode
// emulator`)  AND  this is not a production build. `vite build` always sets
// import.meta.env.PROD, so a deployed bundle can never point at an emulator, and — the other
// way round — an emulator session can never reach production: it is initialised with a
// throw-away `demo-` project config (Firebase treats `demo-*` projects as offline-only) and
// the real `firebaseConfig` above is not used at all.
// ---------------------------------------------------------------------------
const env = import.meta.env || {};
export const USE_EMULATOR = env.VITE_FIREBASE_EMULATOR === "1" && !env.PROD;
export const EMULATOR_PROJECT = "demo-cfs-shop";
const EMULATOR_HOST = "127.0.0.1";
const EMULATOR_PORTS = { auth: 9099, database: 9000, storage: 9199 }; // keep in sync with firebase.json

if (isFirebaseConfigured && USE_EMULATOR) {
  app = initializeApp({
    apiKey: "demo-api-key",
    authDomain: `${EMULATOR_PROJECT}.firebaseapp.com`,
    databaseURL: `http://${EMULATOR_HOST}:${EMULATOR_PORTS.database}?ns=${EMULATOR_PROJECT}-default-rtdb`,
    projectId: EMULATOR_PROJECT,
    storageBucket: `${EMULATOR_PROJECT}.appspot.com`,
  });
  auth = getAuth(app);
  db = getDatabase(app);
  storage = getStorage(app);
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, {
    disableWarnings: true,
  });
  connectDatabaseEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.database);
  connectStorageEmulator(storage, EMULATOR_HOST, EMULATOR_PORTS.storage);
  console.info("[firebase] using LOCAL EMULATOR — project", EMULATOR_PROJECT);
} else if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  storage = getStorage(app);
}

export { app, auth, db, storage };
