import express from "express";
import multer from "multer";
import fs from "fs";
import { createRequire } from "module";
import { ai } from "../services/gemini.js";
import admin, { adminDb, FieldValue, adminAuth, adminStorage } from "../services/firebase.js";
import { aiCache } from "../services/aiCache.js";
import aiProvider from "../services/aiProvider.js";

const require = createRequire(import.meta.url);
const PDFParse = require("pdf-parse");

// Middleware to verify Firebase ID Token securely
async function authenticateMiddleware(req, res, next) {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // Safe fallback to header UID for testing/compatibility
      const fallbackUid = req.headers["x-user-uid"];
      if (fallbackUid) {
        req.user = { 
          uid: fallbackUid, 
          isGuest: fallbackUid.startsWith("guest_") || fallbackUid.includes("anonymous") 
        };
        return next();
      }
      return res.status(401).json({ error: "Unauthorized: Missing Authorization Token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await adminAuth.verifyIdToken(idToken);
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || "",
      isGuest: decodedToken.firebase?.sign_in_provider === "anonymous",
    };
    next();
  } catch (error) {
    console.error("Token verification failed:", error.message);
    return res.status(401).json({ error: "Unauthorized: Invalid Token" });
  }
}

// Helper to refund credit on route failure if the user is not a guest
async function refundCreditIfNeeded(req) {
  try {
    if (req.user && !req.user.isGuest) {
      const userRef = adminDb.collection("users").doc(req.user.uid);
      await userRef.update({
        credits: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp()
      });
      console.log(`[Refund System] Successfully refunded 1 credit to user: ${req.user.uid}`);
    }
  } catch (err) {
    console.error("[Refund System] Failed to refund credit:", err.message);
  }
}

// Helper to mask internal crash messages with professional warnings
function getFriendlyErrorMessage(error) {
  const msg = error.message || "";
  if (
    msg.includes("No speech detected") ||
    msg.includes("Please watch the complete") ||
    msg.includes("Validation") ||
    msg.includes("Missing") ||
    msg.includes("No Credits") ||
    msg.includes("Invalid")
  ) {
    return msg;
  }
  return "All AI services are temporarily unavailable. Please try again shortly.";
}

// Helper to save requests directly to Firestore History
async function saveRequestHistory(uid, toolName, prompt, response, imageUrl = null, pdfUrl = null) {
  try {
    const historyRef = adminDb.collection("history");
    await historyRef.add({
      userId: uid,
      toolName,
      prompt,
      response,
      imageUrl,
      pdfUrl,
      timestamp: FieldValue.serverTimestamp()
    });
    console.log(`Saved history log for tool: ${toolName}, user: ${uid}`);
  } catch (e) {
    console.error("Failed to save history log:", e.message);
  }
}

// Helper to upload base64 image data directly to Firebase Storage
async function uploadBase64ToStorage(base64Data, destinationPath, mimeType = "image/jpeg") {
  try {
    const bucket = adminStorage.bucket();
    const file = bucket.file(destinationPath);
    const buffer = Buffer.from(base64Data, "base64");
    await file.save(buffer, {
      metadata: { contentType: mimeType },
      public: true,
    });
    return `https://storage.googleapis.com/${bucket.name}/${destinationPath}`;
  } catch (e) {
    console.error("Firebase Storage base64 upload failed:", e.message);
    return null;
  }
}

// Helper to upload a local file to Firebase Storage
async function uploadFileToStorage(localFilePath, destinationPath, mimeType) {
  try {
    const bucket = adminStorage.bucket();
    await bucket.upload(localFilePath, {
      destination: destinationPath,
      metadata: { contentType: mimeType },
      public: true,
    });
    return `https://storage.googleapis.com/${bucket.name}/${destinationPath}`;
  } catch (e) {
    console.error("Firebase Storage file upload failed:", e.message);
    return null;
  }
}

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Middleware to verify and deduct credits for all AI routes securely
async function checkCreditsMiddleware(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized: User not authenticated" });
    }

    const { uid, isGuest } = req.user;

    // Guest users bypass credit checks (gated by AdMob ads on the frontend)
    if (isGuest) {
      return next();
    }

    const userRef = adminDb.collection("users").doc(uid);
    const docSnap = await userRef.get();

    if (!docSnap.exists) {
      // First-time user setup: Grant 20 credits, minus 1 for current request
      const newUserData = {
        uid: uid,
        credits: 20,
        premium: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      await userRef.set(newUserData);
      console.log(`First-time setup completed for UID: ${uid} (Granted 20 credits).`);
      
      // Deduct 1 credit for the current request
      await userRef.update({
        credits: 19,
        updatedAt: FieldValue.serverTimestamp()
      });
      return next();
    }

    const userData = docSnap.data();
    
    // Premium users have unlimited credits
    if (userData.premium === true) {
      return next();
    }

    const currentCredits = userData.credits ?? 20;

    if (currentCredits <= 0) {
      return res.status(402).json({ error: "No Credits" });
    }

    // Deduct 1 credit atomically
    await userRef.update({
      credits: FieldValue.increment(-1),
      updatedAt: FieldValue.serverTimestamp()
    });

    next();
  } catch (error) {
    console.error("Credits Verification Middleware Failed:", error.message);
    return res.status(500).json({ error: "Internal Server Error in Credits Verification" });
  }
}

router.use(authenticateMiddleware);
router.use(checkCreditsMiddleware);

// Helper to handle simple text generation using centralized AI manager
async function generateText(prompt, toolName = "AI Tool") {
  return await aiProvider.generate({
    prompt,
    toolName
  });
}

// Helper to parse JSON safely, stripping off any markdown code blocks returned by AI model variations
function parseSafeJson(text) {
  let cleanText = (text || "").trim();
  try {
    cleanText = cleanText
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

    const firstBrace = cleanText.indexOf("{");
    const firstBracket = cleanText.indexOf("[");

    let start;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);

    if (start > 0) cleanText = cleanText.substring(start);

    const lastBrace = cleanText.lastIndexOf("}");
    const lastBracket = cleanText.lastIndexOf("]");

    const end = Math.max(lastBrace, lastBracket);
    if (end !== -1) cleanText = cleanText.substring(0, end + 1);

    return JSON.parse(cleanText);
  } catch (err) {
    console.error("[JSON Parser] Initial parsing failed:", err.message);
    try {
      // Self-healing: Strip trailing commas inside arrays and objects
      const selfHealed = cleanText.replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(selfHealed);
    } catch (healErr) {
      console.error("[JSON Parser] Parsing failed completely. Raw input text:", text);
      throw new Error("Failed to format AI response. Please try again.");
    }
  }
}

// 1. Homework Solver
router.post("/homework", async (req, res) => {
  try {
    const { question, imageBase64 } = req.body;

    if (!question && !imageBase64) {
      return res.status(400).json({ error: "Missing question or image" });
    }

    // Check Cache
    const cacheInputs = { question, imageBase64 };
    const cached = await aiCache.get("Homework Solver", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    let imageUrl = null;
    let responseText;

    if (imageBase64) {
      let cleanBase64 = imageBase64;
      if (cleanBase64.includes("base64,")) {
        cleanBase64 = cleanBase64.split("base64,")[1];
      }

      // Upload to Firebase Storage
      const destinationPath = `users/${req.user.uid}/uploads/homework_${Date.now()}.jpg`;
      imageUrl = await uploadBase64ToStorage(cleanBase64, destinationPath);

      responseText = await aiProvider.generate({
        prompt: question || "Solve the homework in this image. Give a complete step-by-step explanation with correct formulas and formatting.",
        images: [{ mimeType: "image/jpeg", data: cleanBase64 }],
        toolName: "Homework Solver"
      });
    } else {
      const prompt = `You are a professional Homework Solver. Solve the following question in detail using clear step-by-step formatting (markdown). Cover formulas, concepts, and write a thorough response:
      
      Question: ${question}`;

      responseText = await aiProvider.generate({
        prompt,
        toolName: "Homework Solver"
      });
    }

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Homework Solver",
      question || "Analyzed image task",
      responseText,
      imageUrl,
      null
    );

    const finalResult = { result: responseText };
    await aiCache.set("Homework Solver", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Homework Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 2. PDF Summary
router.post("/pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded" });
    }

    const dataBuffer = fs.readFileSync(req.file.path);
    const parser = new PDFParse(dataBuffer);
    const pdfData = await parser;
    const text = pdfData.text;

    if (!text || text.trim().length === 0) {
      // Clean up temp file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      return res.status(400).json({ error: "Failed to extract text from PDF." });
    }

    // Check Cache
    const cacheInputs = { text };
    const cached = await aiCache.get("PDF Summary", cacheInputs);
    if (cached) {
      // Clean up temp file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    // Upload to Firebase Storage (only on cache miss!)
    const destinationPath = `users/${req.user.uid}/uploads/pdf_${Date.now()}.pdf`;
    const pdfUrl = await uploadFileToStorage(req.file.path, destinationPath, "application/pdf");

    // clean up uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      console.error("Temp file cleanup failed:", e);
    }

    const prompt = `Analyze the following PDF content and generate a comprehensive summary.
    Return ONLY a JSON object matching this schema (do not wrap in markdown blocks, just raw JSON):
    {
      "summary": "Brief executive summary (2-3 paragraphs)",
      "bulletPoints": ["Key point 1", "Key point 2", "Key point 3", "Key point 4"],
      "chapterSummary": [
        {"title": "Section/Chapter 1", "summary": "Section 1 summary..."},
        {"title": "Section/Chapter 2", "summary": "Section 2 summary..."}
      ],
      "importantQuestions": [
        {"question": "Question 1", "answer": "Answer 1"},
        {"question": "Question 2", "answer": "Answer 2"}
      ],
      "keyPoints": ["Important term/concept 1: definition", "Important term/concept 2: definition"]
    }

    PDF Text:
    ${text.substring(0, 20000)}`;

    const responseText = await aiProvider.generate({
      prompt,
      responseMimeType: "application/json",
      schemaType: "pdf",
      toolName: "PDF Summary"
    });

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "PDF Summary",
      `Summarized document: ${req.file.originalname || "Uploaded PDF"}`,
      responseText,
      null,
      pdfUrl
    );

    const finalResult = parseSafeJson(responseText);
    await aiCache.set("PDF Summary", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("PDF Summary Error:", error);
    // Clean up temp file in case of error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 3. Image Analyzer
router.post("/image-analyzer", async (req, res) => {
  try {
    const { imageBase64, mode } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing image data" });
    }

    // Check Cache
    const cacheInputs = { imageBase64, mode };
    const cached = await aiCache.get("Image Analyzer", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    let cleanBase64 = imageBase64;
    if (cleanBase64.includes("base64,")) {
      cleanBase64 = cleanBase64.split("base64,")[1];
    }

    // Upload to Firebase Storage
    const destinationPath = `users/${req.user.uid}/uploads/analyzer_${Date.now()}.jpg`;
    const imageUrl = await uploadBase64ToStorage(cleanBase64, destinationPath);

    let instruction = "Analyze this image and explain what is in it.";
    if (mode === "ocr") {
      instruction = "Perform OCR on this image. Extract and transcribe all visible text accurately. Keep original line breaks and layout structure where possible.";
    } else if (mode === "objects") {
      instruction = "Identify all significant objects, items, people, and visual elements in this image. List them with descriptions.";
    } else if (mode === "solve") {
      instruction = "Look at the question or problem in this image and solve it step-by-step. Provide explanations.";
    }

    const responseText = await aiProvider.generate({
      prompt: instruction,
      images: [{ mimeType: "image/jpeg", data: cleanBase64 }],
      toolName: "Image Analyzer"
    });

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Image Analyzer",
      `Image Analysis (${mode || "general"})`,
      responseText,
      imageUrl,
      null
    );

    const finalResult = { result: responseText };
    await aiCache.set("Image Analyzer", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Image Analyzer Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 4. Image Generator
router.post("/image-generator", async (req, res) => {
  try {
    const { prompt, style } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // Check Cache
    const cacheInputs = { prompt, style };
    const cached = await aiCache.get("Image Generator", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    const styledPrompt = style ? `A beautiful image in ${style} style: ${prompt}` : prompt;

    const imageResult = await aiProvider.generateImage({ prompt, style });

    let imageUrl = null;
    let statusText = "Generated art image (native)";

    if (imageResult.base64Bytes) {
      const destinationPath = `users/${req.user.uid}/generations/art_${Date.now()}.jpg`;
      imageUrl = await uploadBase64ToStorage(imageResult.base64Bytes, destinationPath);
    } else {
      imageUrl = imageResult.fallbackUrl;
      statusText = "Generated art image (fallback)";
    }

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Image Generator",
      styledPrompt,
      statusText,
      imageUrl,
      null
    );

    const finalResult = { imageUrl };
    await aiCache.set("Image Generator", cacheInputs, finalResult);

    return res.json(finalResult);
  } catch (error) {
    console.error("Image Generator Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 5. WhatsApp Reply Generator
router.post("/whatsapp", async (req, res) => {
  try {
    const { message, tone, length } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    // Check Cache
    const cacheInputs = { message, tone, length };
    const cached = await aiCache.get("WhatsApp Reply", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    const prompt = `Create a WhatsApp response for this incoming message: "${message}".
    
    Style Guidelines:
    - Tone: ${tone || "friendly"} (friendly, professional, funny, formal)
    - Length: ${length || "short"} (short: one sentence/quick; long: detailed/thoughtful)
    
    Provide 3 distinct response variations.
    Return ONLY a JSON array of strings:
    ["Option 1", "Option 2", "Option 3"]`;

    const responseText = await aiProvider.generate({
      prompt,
      responseMimeType: "application/json",
      schemaType: "whatsapp",
      toolName: "WhatsApp Reply"
    });

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "WhatsApp Reply",
      `Generate WhatsApp reply for: "${message.substring(0, 100)}..."`,
      responseText
    );

    const finalResult = { options: parseSafeJson(responseText) };
    await aiCache.set("WhatsApp Reply", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("WhatsApp Reply Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 6. Email Writer
router.post("/email", async (req, res) => {
  try {
    const { purpose, tone, details } = req.body;

    if (!purpose) {
      return res.status(400).json({ error: "Missing purpose" });
    }

    // Check Cache
    const cacheInputs = { purpose, tone, details };
    const cached = await aiCache.get("Email Writer", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    const prompt = `Write a high-quality email draft.
    
    Details:
    - Purpose/Topic: ${purpose} (e.g. Job Application, Complaint, Request, Resignation)
    - Tone: ${tone || "professional"} (professional, casual, formal, persuasive, friendly)
    - Context/Details: ${details || "None specified"}
    
    Structure the email clearly with a Subject Line, Salutation, Body paragraphs, and a sign-off placeholder. Use clear markdown spacing.`;

    const result = await generateText(prompt, "Email Writer");

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Email Writer",
      `Email topic: ${purpose}`,
      result
    );

    const finalResult = { result };
    await aiCache.set("Email Writer", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Email Writer Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 7. Translator
router.post("/translator", async (req, res) => {
  try {
    const { text, targetLanguage } = req.body;

    if (!text || !targetLanguage) {
      return res.status(400).json({ error: "Missing text or targetLanguage" });
    }

    // Check Cache
    const cacheInputs = { text, targetLanguage };
    const cached = await aiCache.get("Translator", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    const prompt = `Translate the following text into ${targetLanguage}. Return ONLY the direct translation, do not add introductory remarks or explanation:
    
    "${text}"`;

    const result = await generateText(prompt, "Translator");

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Translator",
      `Translate to ${targetLanguage}: "${text.substring(0, 100)}..."`,
      result.trim()
    );

    const finalResult = { result: result.trim() };
    await aiCache.set("Translator", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Translator Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 8. Code Generator
router.post("/code", async (req, res) => {
  try {
    const { code, language, action, prompt } = req.body;

    if (!action) {
      return res.status(400).json({ error: "Missing action" });
    }

    // Check Cache
    const cacheInputs = { code, language, action, prompt };
    const cached = await aiCache.get("Code Generator", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    let query = "";
    if (action === "generate") {
      query = `Generate a programming solution in ${language || "Javascript"}. Requirement: ${prompt}. Explain the code briefly.`;
    } else if (action === "explain") {
      query = `Explain this ${language || ""} code step-by-step:
      \`\`\`
      ${code}
      \`\`\`;`;
    } else if (action === "fix") {
      query = `Identify and fix bugs in this ${language || ""} code:
      \`\`\`
      ${code}
      \`\`\`
      Explain what the bugs were and provide the clean, corrected code.`;
    } else if (action === "optimize") {
      query = `Optimize the following ${language || ""} code for performance and readability:
      \`\`\`
      ${code}
      \`\`\`
      Explain the improvements made and show the optimized code.`;
    }

    const result = await generateText(query, "Code Generator");

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Code Generator",
      `Code action (${action}) in ${language || "code"}: ${prompt || ""}`,
      result
    );

    const finalResult = { result };
    await aiCache.set("Code Generator", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Code Generator Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 9. Scam Detector
router.post("/scam", async (req, res) => {
  try {
    const { message, imageBase64 } = req.body;

    if (!message && !imageBase64) {
      return res.status(400).json({ error: "Missing text message or screenshot image" });
    }

    // Check Cache
    const cacheInputs = { message, imageBase64 };
    const cached = await aiCache.get("Scam Detector", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    let imageUrl = null;
    let responseText;

    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

      // Upload to Firebase Storage
      const destinationPath = `users/${req.user.uid}/uploads/scam_${Date.now()}.jpg`;
      imageUrl = await uploadBase64ToStorage(cleanBase64, destinationPath);

      const promptStr = `Analyze this image (which is a screenshot of a conversation, chat, email, message, payment receipt, website, etc.) and check if it represents a scam, phishing attempt, or fraudulent activity. If additional text was typed by the user, take it into account: "${message || ""}".
      
      Read the text from the screenshot and analyze the conversation context.
      Evaluate the scam probability (0 to 100), explain why it's a scam or safe, highlight the risk factors (suspicious parts), and provide safety recommendations.
      Return ONLY a JSON object matching this schema (do not wrap in markdown, just return raw JSON):
      {
        "scamProbability": 85,
        "explanation": "Detailed breakdown of the conversation, message, or receipt shown in the screenshot.",
        "riskFactors": [
          "Suspicious link",
          "Urgent threat language",
          "Asks for OTP/PIN code"
        ],
        "recommendations": [
          "Do not tap any links",
          "Block and report the sender",
          "Do not share any OTP codes"
        ]
      }`;

      responseText = await aiProvider.generate({
        prompt: promptStr,
        images: [{ mimeType: "image/jpeg", data: cleanBase64 }],
        responseMimeType: "application/json",
        schemaType: "scam",
        toolName: "Scam Detector"
      });
    } else {
      const promptStr = `Analyze this message and check if it is a scam, phishing attempt, or fraudulent: "${message}".
      Evaluate the risk. Return ONLY a JSON object matching this schema (do not wrap in markdown, just return raw JSON):
      {
        "scamProbability": 85,
        "explanation": "Brief explanation of why this was flagged as a scam or safe.",
        "riskFactors": [
          "Urgent language",
          "Requests personal credentials/banking info",
          "Suspicious link format"
        ],
        "recommendations": [
          "Do not click any link",
          "Block the sender",
          "Verify with the official organization"
        ]
      }`;

      responseText = await aiProvider.generate({
        prompt: promptStr,
        responseMimeType: "application/json",
        schemaType: "scam",
        toolName: "Scam Detector"
      });
    }

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Scam Detector",
      message ? `Scam check for: "${message.substring(0, 100)}..."` : "Scam check screenshot",
      responseText,
      imageUrl,
      null
    );

    const finalResult = parseSafeJson(responseText);
    await aiCache.set("Scam Detector", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Scam Detector Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 10. Fake News Detector
router.post("/fake-news", async (req, res) => {
  try {
    const { news, imageBase64 } = req.body;

    if (!news && !imageBase64) {
      return res.status(400).json({ error: "Missing news text or screenshot image" });
    }

    // Check Cache
    const cacheInputs = { news, imageBase64 };
    const cached = await aiCache.get("Fake News Detector", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    let imageUrl = null;
    let responseText;

    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

      // Upload to Firebase Storage
      const destinationPath = `users/${req.user.uid}/uploads/fakenews_${Date.now()}.jpg`;
      imageUrl = await uploadBase64ToStorage(cleanBase64, destinationPath);

      const promptStr = `Analyze this news image, screenshot (of an X/Twitter post, Facebook post, news article, WhatsApp forward, etc.) and check for fake news, fabricated claims, manipulations, or misleading context. If additional text was provided by the user, incorporate it: "${news || ""}".
      
      Read the text from the image, understand its full context, detect bias or manipulation, and output the credibility analysis.
      Return ONLY a JSON object matching this schema (do not wrap in markdown, just return raw JSON):
      {
        "credibilityScore": 45,
        "verdict": "Suspicious / Fake / True / Misleading / Unverified",
        "explanation": "A breakdown of the claim's factual accuracy.",
        "sources": [
          "Reliable reference 1 (e.g. Associated Press)",
          "Fact-checking reference 2 (e.g. Snopes)"
        ],
        "bias": "Left-leaning / Right-leaning / Neutral / Clickbait"
      }`;

      responseText = await aiProvider.generate({
        prompt: promptStr,
        images: [{ mimeType: "image/jpeg", data: cleanBase64 }],
        responseMimeType: "application/json",
        schemaType: "fake-news",
        toolName: "Fake News Detector"
      });
    } else {
      const promptStr = `Critically analyze this news story, claim, or article: "${news}".
      Verify its facts and determine the credibility. Return ONLY a JSON object matching this schema (do not wrap in markdown, just return raw JSON):
      {
        "credibilityScore": 45,
        "verdict": "Suspicious / Fake / True / Misleading / Unverified",
        "explanation": "A breakdown of the claim's factual accuracy.",
        "sources": [
          "Reliable reference 1 (e.g. Associated Press)",
          "Fact-checking reference 2 (e.g. Snopes)"
        ],
        "bias": "Left-leaning / Right-leaning / Neutral / Clickbait"
      }`;

      responseText = await aiProvider.generate({
        prompt: promptStr,
        responseMimeType: "application/json",
        schemaType: "fake-news",
        toolName: "Fake News Detector"
      });
    }

    // Save history log automatically
    await saveRequestHistory(
      req.user.uid,
      "Fake News Detector",
      news ? `News check for: "${news.substring(0, 100)}..."` : "News check screenshot",
      responseText,
      imageUrl,
      null
    );

    const finalResult = parseSafeJson(responseText);
    await aiCache.set("Fake News Detector", cacheInputs, finalResult);

    res.json(finalResult);
  } catch (error) {
    console.error("Fake News Detector Error:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

// 11. Voice Chat (supports both typed text and direct audio input)
router.post("/voice", async (req, res) => {
  try {
    const { message, audioBase64, history } = req.body;
    console.log(`[Voice Route] Incoming request from UID: ${req?.user?.uid || "unknown"}. Text message: ${message ? "Yes" : "No"}, Audio input: ${audioBase64 ? "Yes" : "No"}`);

    if (!message && !audioBase64) {
      console.warn("[Voice Route] Validation Failure: Missing text message or audio input");
      return res.status(400).json({ error: "Missing text message or audio input" });
    }

    // Check Cache
    const cacheInputs = { message, audioBase64, history };
    const cached = await aiCache.get("Voice Chat", cacheInputs);
    if (cached) {
      await refundCreditIfNeeded(req);
      return res.json(cached);
    }

    let audioUrl = null;

    if (audioBase64) {
      let cleanAudio = audioBase64;
      if (cleanAudio.includes("base64,")) {
        cleanAudio = cleanAudio.split("base64,")[1];
      }

      const audioSize = Buffer.from(cleanAudio, "base64").length;
      console.log(`[Voice Route] Audio payload size: ${audioSize} bytes`);

      if (audioSize === 0) {
        console.warn("[Voice Route] Validation Failure: Audio payload size is zero");
        return res.status(400).json({ error: "Audio recording is empty. Please try again." });
      }

      // Upload audio to Firebase Storage
      const destinationPath = `users/${req.user.uid}/uploads/voice_${Date.now()}.m4a`;
      audioUrl = await uploadBase64ToStorage(cleanAudio, destinationPath);

      const promptStr = `Listen to the user speaking in this audio file.
      1. Transcribe the user's spoken words accurately.
      2. Formulate a short, natural, conversational spoken response (1-2 sentences).
      
      CRITICAL SAFETY DIRECTIVES:
      - If the audio contains only silence, background noise, or no clear speech, transcribe it exactly as "NO_SPEECH" and set "answer" to "NO_SPEECH".
      - Never hallucinate or guess spoken words if the audio is unclear.
      
      Return ONLY a JSON object matching this schema (do not wrap in markdown, just raw JSON):
      {
        "transcription": "The exact words spoken by the user",
        "answer": "Your conversational response to their question"
      }`;

      const responseText = await aiProvider.generate({
        prompt: promptStr,
        audio: { mimeType: "audio/m4a", data: cleanAudio },
        responseMimeType: "application/json",
        schemaType: "voice",
        history,
        toolName: "Voice Chat"
      });

      console.log("[Voice Route] AI response text:", responseText);
      const parsed = parseSafeJson(responseText);

      // Validate transcription output
      if (
        !parsed.transcription || 
        parsed.transcription === "NO_SPEECH" || 
        parsed.answer === "NO_SPEECH" ||
        parsed.transcription.trim().length === 0
      ) {
        console.warn("[Voice Route] No speech detected in audio file");
        throw new Error("No speech detected. Please try again.");
      }

      console.log(`[Voice Route] Transcribed text: "${parsed.transcription}"`);

      // Save history log automatically
      await saveRequestHistory(
        req.user.uid,
        "Voice Chat",
        `Voice input: "${parsed.transcription}"`,
        parsed.answer,
        null,
        audioUrl
      );

      const finalResult = {
        transcription: parsed.transcription,
        result: parsed.answer,
      };
      await aiCache.set("Voice Chat", cacheInputs, finalResult);

      return res.json(finalResult);

    } else {
      const promptStr = `Answer this in a short, natural, conversational spoken tone (1-2 sentences): ${message}`;

      const responseText = await aiProvider.generate({
        prompt: promptStr,
        history,
        toolName: "Voice Chat"
      });

      console.log("[Voice Route] AI text response:", responseText);

      // Save history log automatically
      await saveRequestHistory(
        req.user.uid,
        "Voice Chat",
        `Text voice query: "${message}"`,
        responseText,
        null,
        null
      );

      const finalResult = {
        transcription: message,
        result: responseText,
      };
      await aiCache.set("Voice Chat", cacheInputs, finalResult);

      return res.json(finalResult);
    }
  } catch (error) {
    console.error("[Voice Route] Exception occurred:", error);
    await refundCreditIfNeeded(req);
    res.status(500).json({ error: getFriendlyErrorMessage(error) });
  }
});

export default router;
