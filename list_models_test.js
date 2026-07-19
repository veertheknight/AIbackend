import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function testGenerate() {
  try {
    console.log("Testing generation with gemini-3.5-flash...");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Hello, answer in one word: what is 2+2?",
    });
    console.log("Success! Response text:", response.text);
  } catch (error) {
    console.error("Test generation failed:", error.message);
  }
}

testGenerate();
