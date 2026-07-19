import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function listModels() {
  try {
    console.log("Using API key starting with:", process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.slice(0, 10) : "MISSING");
    const response = await ai.models.list();
    console.log("Raw response:", JSON.stringify(response));
  } catch (error) {
    console.error("Failed to list models:", error.message);
  }
}

listModels();
