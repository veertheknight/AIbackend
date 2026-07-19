import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

let adminApp;
try {
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (serviceAccountKey) {
    adminApp = admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountKey)),
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
export default adminApp;
