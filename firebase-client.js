import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  browserSessionPersistence,
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
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
import {
  firebaseConfig as productionFirebaseConfig,
  useFirebaseEmulators as configuredEmulators,
} from "./firebase-config.js";

// Temporary local test mode is available only on localhost.
// It uses Firebase Emulator Suite and a demo project ID; it cannot reach production.
export const localTestMode = ["localhost", "127.0.0.1"].includes(location.hostname);
const firebaseConfig = localTestMode
  ? {
      ...productionFirebaseConfig,
      authDomain: "localhost",
      projectId: "demo-splendor-local",
      databaseURL: "https://demo-splendor-local-default-rtdb.firebaseio.com",
    }
  : productionFirebaseConfig;
const useFirebaseEmulators = localTestMode || configuredEmulators;

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
let authInitialization = Promise.resolve();

if (firebaseReady) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  if (localTestMode) {
    authInitialization = setPersistence(auth, browserSessionPersistence);
  }
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
  authInitialization,
  realtimeDb,
  signInAnonymously,
};
