import crypto from "crypto";
import { adminDb } from "./firebase.js";

// In-Memory L1 Cache Map
const memoryCache = new Map();

// Helper to compute MD5 hash of strings (especially large files / base64 payloads)
function md5(value) {
  return crypto.createHash("md5").update(value || "").digest("hex");
}

/**
 * Generates a unique, short cache key based on the tool name and inputs.
 * If inputs contain large strings (base64, PDFs, or long text), it hashes them.
 */
export function generateCacheKey(toolName, inputs) {
  const cleanedInputs = {};
  for (const [key, value] of Object.entries(inputs || {})) {
    if (typeof value === "string" && (value.length > 300 || value.startsWith("data:") || key.toLowerCase().includes("base64"))) {
      cleanedInputs[key] = md5(value); // Keep cache key small by hashing large payloads
    } else {
      cleanedInputs[key] = value;
    }
  }

  const serialized = JSON.stringify({
    tool,
    inputs: cleanedInputs
  });

  return md5(serialized);
}

// Global variable fallback for name resolution inside generateCacheKey
const tool = "";

class AICacheManager {
  /**
   * Retrieves a cached response if valid and not expired.
   */
  async get(toolName, inputs) {
    const keyInputs = inputs || {};
    const serialized = JSON.stringify({
      toolName,
      inputs: Object.entries(keyInputs).reduce((acc, [k, v]) => {
        if (typeof v === "string" && (v.length > 300 || v.startsWith("data:") || k.toLowerCase().includes("base64"))) {
          acc[k] = md5(v);
        } else {
          acc[k] = v;
        }
        return acc;
      }, {})
    });
    const cacheKey = md5(serialized);

    const now = Date.now();

    // 1. Check L1 Memory Cache
    if (memoryCache.has(cacheKey)) {
      const entry = memoryCache.get(cacheKey);
      if (entry.expiresAt > now) {
        console.log(`[Cache Hit - L1] Tool: ${toolName}, Key: ${cacheKey}`);
        return entry.response;
      } else {
        console.log(`[Cache Expired - L1] Tool: ${toolName}, Key: ${cacheKey}. Evicting.`);
        memoryCache.delete(cacheKey);
      }
    }

    // 2. Check L2 Firestore Cache
    try {
      const docRef = adminDb.collection("ai_cache").doc(cacheKey);
      const docSnap = await docRef.get();

      if (docSnap.exists) {
        const data = docSnap.data();
        const expiresAt = data.expiresAt.toDate().getTime();

        if (expiresAt > now) {
          console.log(`[Cache Hit - L2] Tool: ${toolName}, Key: ${cacheKey}`);
          
          // Populate L1 Cache
          memoryCache.set(cacheKey, {
            response: data.response,
            expiresAt
          });

          return data.response;
        } else {
          console.log(`[Cache Expired - L2] Tool: ${toolName}, Key: ${cacheKey}. Deleting document.`);
          await docRef.delete();
          console.log(`[Cache Deleted] Deleted expired Firestore key: ${cacheKey}`);
        }
      }
    } catch (error) {
      console.error("[Cache L2 Error] Failed to read from Firestore:", error.message);
    }

    console.log(`[Cache Miss] Tool: ${toolName}, Key: ${cacheKey}. Calling Gemini API...`);
    return null;
  }

  /**
   * Saves a successful response to both memory and Firestore caches with a 24-hour expiration.
   */
  async set(toolName, inputs, response) {
    if (!response) return;

    const keyInputs = inputs || {};
    const serialized = JSON.stringify({
      toolName,
      inputs: Object.entries(keyInputs).reduce((acc, [k, v]) => {
        if (typeof v === "string" && (v.length > 300 || v.startsWith("data:") || k.toLowerCase().includes("base64"))) {
          acc[k] = md5(v);
        } else {
          acc[k] = v;
        }
        return acc;
      }, {})
    });
    const cacheKey = md5(serialized);

    const now = Date.now();
    const lifetimeMs = 24 * 60 * 60 * 1000; // 24 Hours
    const expiresAt = now + lifetimeMs;

    // Save to L1 Memory
    memoryCache.set(cacheKey, {
      response,
      expiresAt
    });

    // Save to L2 Firestore
    try {
      const docRef = adminDb.collection("ai_cache").doc(cacheKey);
      await docRef.set({
        toolName,
        cacheKey,
        response,
        createdAt: new Date(now),
        expiresAt: new Date(expiresAt)
      });
      console.log(`[Cache Saved] Saved response for Tool: ${toolName}, Key: ${cacheKey}`);
    } catch (error) {
      console.error("[Cache Save L2 Error] Failed to save in Firestore:", error.message);
    }
  }
}

export const aiCache = new AICacheManager();
export default aiCache;
