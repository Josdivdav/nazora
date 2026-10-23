import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { existsSync, readFileSync } from "node:fs";

let adminApp = null;
let db = null;

const DATABASE_URL = "https://goodvibes-9cde0-default-rtdb.firebaseio.com";

function initFirebaseAdmin() {
  if (getApps().length > 0) {
    adminApp = getApps()[0];
    db = getDatabase(adminApp);
    return db;
  }

  const possiblePaths = [
    new URL("../../goodvibes.json", import.meta.url),
    new URL("../../../goodvibes.json", import.meta.url),
    "./goodvibes.json",
  ];

  let serviceAccount = null;

  for (const p of possiblePaths) {
    try {
      if (existsSync(p)) {
        serviceAccount = JSON.parse(readFileSync(p, "utf8"));
        console.log(`[Firebase] Loaded service account from ${p}`);
        break;
      }
    } catch {}
  }

  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      console.log("[Firebase] Loaded service account from FIREBASE_SERVICE_ACCOUNT env var.");
    } catch (err) {
      console.error("[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", err.message);
    }
  }

  try {
    if (serviceAccount) {
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        databaseURL: DATABASE_URL,
      });
      console.log("[Firebase] Initialized with Service Account credentials.");
    } else {
      console.warn(
        "[Firebase] Notice: goodvibes.json not found. Initializing without private key credentials (ensure RTDB rules allow access or place goodvibes.json in backend/)."
      );
      adminApp = initializeApp({
        databaseURL: DATABASE_URL,
      });
    }

    db = getDatabase(adminApp);
  } catch (err) {
    console.error("[Firebase] Initialization error:", err.message);
  }

  return db;
}

db = initFirebaseAdmin();

export { db, adminApp, initFirebaseAdmin };
export default db;
