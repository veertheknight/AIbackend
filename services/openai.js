import OpenAI from "openai";
import dotenv from "dotenv";
import GroqProvider from "./groq.js";

dotenv.config();

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

export const OpenAIProvider = {
  name: "OpenAI",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history, signal }) {
    if (!openai) {
      throw new Error("OpenAI API key not configured");
    }

    const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    let messages = [];

    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }

    // Map history to OpenAI format
    if (history && history.length > 0) {
      for (const h of history) {
        const role = h.role === "model" ? "assistant" : "user";
        const content = h.parts.map(p => p.text).join("\n");
        messages.push({ role, content });
      }
    }

    // Handle audio: transcribing using Groq if possible
    let userPrompt = prompt;
    if (audio) {
      console.log("[OpenAI Provider] Attempting audio transcription via Groq...");
      try {
        const tempParams = {
          prompt: "",
          audio,
          signal
        };
        const transcript = await GroqProvider.generate(tempParams);
        console.log(`[OpenAI Provider] Audio transcribed successfully: "${transcript}"`);
        userPrompt = `${prompt}\nUser voice input: "${transcript}"`;
      } catch (err) {
        console.error("[OpenAI Provider] Audio transcription fallback failed:", err.message);
        throw new Error("Audio input is not supported on OpenAI without Groq configuration.");
      }
    }

    // Handle multimodal images
    if (images && images.length > 0) {
      const contents = [{ type: "text", text: userPrompt }];

      for (const img of images) {
        contents.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mimeType || "image/jpeg"};base64,${img.data}`,
          },
        });
      }

      messages.push({ role: "user", content: contents });
    } else {
      messages.push({ role: "user", content: userPrompt });
    }

    const options = {
      model,
      messages,
    };

    if (temperature !== undefined) {
      options.temperature = temperature;
    }

    if (responseMimeType === "application/json") {
      options.response_format = { type: "json_object" };
    }

    const response = await openai.chat.completions.create(options, { signal });

    if (!response.choices || !response.choices[0] || !response.choices[0].message) {
      throw new Error("Empty response from OpenAI");
    }

    return response.choices[0].message.content;
  },

  async generateImage({ prompt, style }) {
    throw new Error("OpenAI provider does not support native image generation in this context.");
  }
};

export default OpenAIProvider;
