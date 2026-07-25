import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export const GeminiProvider = {
  name: "Gemini",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history }) {
    let contents = [];

    // Map history to GoogleGenAI SDK format if provided
    if (history && history.length > 0) {
      contents = history.map(h => ({
        role: h.role === "model" ? "model" : "user",
        parts: h.parts.map(p => ({ text: p.text }))
      }));
    }

    const userParts = [{ text: prompt }];

    // Handle multimodal images (array of base64 items)
    if (images && images.length > 0) {
      for (const img of images) {
        userParts.push({
          inlineData: {
            mimeType: img.mimeType || "image/jpeg",
            data: img.data,
          },
        });
      }
    }

    // Handle multimodal audio
    if (audio) {
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

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config,
    });

    if (!response || !response.text) {
      throw new Error("Empty Response from Gemini");
    }

    return response.text;
  },

};

export default GeminiProvider;