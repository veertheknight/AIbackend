import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

console.log("Gemini API Key:", process.env.GEMINI_API_KEY?.slice(0, 10));

export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});