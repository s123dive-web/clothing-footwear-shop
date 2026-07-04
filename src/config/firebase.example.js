// ---------------------------------------------------------------------------
// TEMPLATE — copy this file's contents into src/config/firebase.js and fill in
// your own Firebase project's values. This example file is committed to the repo
// as a reference; the real config lives in firebase.js.
//
// See the README ("Firebase setup") for step-by-step instructions on creating the
// project, enabling Realtime Database + Authentication, and deploying the rules.
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

export const isFirebaseConfigured =
  !!firebaseConfig.apiKey &&
  !!firebaseConfig.databaseURL &&
  !!firebaseConfig.projectId &&
  !/YOUR_|PLACEHOLDER|xxxx/i.test(
    [firebaseConfig.apiKey, firebaseConfig.databaseURL, firebaseConfig.projectId].join("|")
  );

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
