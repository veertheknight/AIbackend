import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in backend environment.");
  }
  return new GoogleGenAI({ apiKey });
}

export const GeminiProvider = {
  name: "Gemini",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history }) {
    const client = getGeminiClient();
    let contents = [];

    if (history && history.length > 0) {
      contents = history.map(h => ({
        role: h.role === "model" ? "model" : "user",
        parts: (h.parts || []).map(p => ({ text: p.text || "" }))
      }));
    }

    const userParts = [];
    if (prompt) {
      userParts.push({ text: prompt });
    }

    if (images && images.length > 0) {
      for (const img of images) {
        if (img.data) {
          userParts.push({
            inlineData: {
              mimeType: img.mimeType || "image/jpeg",
              data: img.data,
            },
          });
        }
      }
    }

    if (audio && audio.data) {
      userParts.push({
        inlineData: {
          mimeType: audio.mimeType || "audio/m4a",
          data: audio.data,
        },
      });
    }

    contents.push({
      role: "user",
      parts: userParts,
    });

    const config = {};
    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }
    if (responseMimeType) {
      config.responseMimeType = responseMimeType;
    }
    if (temperature !== undefined) {
      config.temperature = temperature;
    }

    // Attempt generateContent across supported Gemini models
    const modelsToTry = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro"];
    let lastErr = null;

    for (const modelName of modelsToTry) {
      try {
        const response = await client.models.generateContent({
          model: modelName,
          contents,
          config,
        });

        if (response && response.text) {
          return response.text;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error("Failed to generate content from Gemini API models.");
  },
};

export default GeminiProvider;