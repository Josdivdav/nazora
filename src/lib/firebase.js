import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { readFileSync } from "node:fs";

const serviceAccount = JSON.parse(
  readFileSync(new URL("../../goodvibes.json", import.meta.url), "utf8")
);

initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://goodvibes-9cde0-default-rtdb.firebaseio.com",
});

const db = getDatabase();

export default db;