import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  runTransaction,
  setDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  connectDatabaseEmulator,
  serverTimestamp,
  set,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";
import { firebaseConfig, useFirebaseEmulators } from "./firebase-config.js";

const requiredConfig = ["apiKey", "authDomain", "projectId", "appId"];
export const firebaseReady = requiredConfig.every((key) => {
  const value = firebaseConfig[key];
  return value && !value.startsWith("YOUR_");
});
export const firebasePresenceReady = Boolean(
  firebaseConfig.databaseURL && !firebaseConfig.databaseURL.startsWith("YOUR_")
);

let auth = null;
let db = null;
let realtimeDb = null;

if (firebaseReady) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  if (firebasePresenceReady) {
    realtimeDb = getDatabase(app);
  }

  if (useFirebaseEmulators) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    if (realtimeDb) connectDatabaseEmulator(realtimeDb, "127.0.0.1", 9000);
  }
}

export {
  auth,
  collection,
  db,
  doc,
  getDoc,
  onAuthStateChanged,
  onDisconnect,
  onSnapshot,
  onValue,
  ref,
  runTransaction,
  writeBatch,
  serverTimestamp,
  set,
  setDoc,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  realtimeDb,
};
