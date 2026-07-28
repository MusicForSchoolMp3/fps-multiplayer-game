// ─── server/firebase.js ──────────────────────────────────────────────────────────
// Firebase Admin SDK configuration for server-side authentication and database

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

// Check if required environment variables are set
if (
  !process.env.FIREBASE_PROJECT_ID ||
  !process.env.FIREBASE_PRIVATE_KEY ||
  !process.env.FIREBASE_CLIENT_EMAIL
) {
  console.error("Missing Firebase environment variables.");
  console.error("Required:");
  console.error("- FIREBASE_PROJECT_ID");
  console.error("- FIREBASE_PRIVATE_KEY");
  console.error("- FIREBASE_CLIENT_EMAIL");
  process.exit(1);
}

const serviceAccount = {
  type: process.env.FIREBASE_TYPE || "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url:
    "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
};

try {
  console.log("Firebase Admin SDK version loaded.");
  console.log("Project ID:", process.env.FIREBASE_PROJECT_ID);
  console.log("Private key exists:", !!process.env.FIREBASE_PRIVATE_KEY);

  console.log("Private key length:", process.env.FIREBASE_PRIVATE_KEY.length);
  console.log(
    "Starts with:",
    JSON.stringify(process.env.FIREBASE_PRIVATE_KEY.slice(0, 35))
  );
  console.log(
    "Ends with:",
    JSON.stringify(process.env.FIREBASE_PRIVATE_KEY.slice(-35))
  );
  console.log(
    "Contains literal \\n:",
    process.env.FIREBASE_PRIVATE_KEY.includes("\\n")
  );
  console.log(
    "Contains real newline:",
    process.env.FIREBASE_PRIVATE_KEY.includes("\n")
  );

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });

    console.log("✅ Firebase Admin initialized successfully.");
  }
} catch (error) {
  console.error("❌ Firebase Admin initialization failed:");
  console.error(error);
  process.exit(1);
}
const auth = getAuth();
const db = getDatabase();

export { auth, db };