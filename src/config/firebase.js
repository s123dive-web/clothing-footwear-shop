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

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  storage = getStorage(app);
}

export { app, auth, db, storage };
