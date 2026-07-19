import admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import dotenv from "dotenv";

dotenv.config();

let adminApp;
try {
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccountKey) {
    let parsedKey;
    try {
      parsedKey = JSON.parse(serviceAccountKey);
    } catch (parseErr) {
      console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:", parseErr.message);
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON format.");
    }
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(parsedKey),
      storageBucket: "oneai-609b5.firebasestorage.app"
    });
    console.log("Firebase Admin SDK initialized via Service Account Key.");
  } else {
    adminApp = admin.initializeApp({
      projectId: "oneai-609b5",
      storageBucket: "oneai-609b5.firebasestorage.app"
    });
    console.log("Firebase Admin SDK initialized via Project ID.");
  }
} catch (error) {
  console.warn("Failed to initialize standard Firebase Admin SDK, initializing in limited mode:", error.message);
  adminApp = admin.initializeApp({
    projectId: "oneai-609b5"
  }, "limited");
}

export const adminDb = admin.firestore(adminApp);
export const adminAuth = admin.auth(adminApp);
export const adminStorage = admin.storage(adminApp);
export { FieldValue };
export default adminApp;
