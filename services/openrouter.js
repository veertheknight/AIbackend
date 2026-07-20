import OpenAI from "openai";
import dotenv from "dotenv";
import GroqProvider from "./groq.js";

dotenv.config();

let openRouter = null;
if (process.env.OPENROUTER_API_KEY) {
  openRouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      "HTTP-Referer": "https://lumina-ai-app.com",
      "X-Title": "Lumina AI App",
    }
  });
}

export const OpenRouterProvider = {
  name: "OpenRouter",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history, signal }) {
    if (!openRouter) {
      throw new Error("OpenRouter API key not configured");
    }

    let model = "meta-llama/llama-3.3-70b-instruct";
    let messages = [];

    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }

    // Map history
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
      console.log("[OpenRouter Provider] Attempting audio transcription via Groq...");
      try {
        // Reuse Groq transcription logic if key is configured
        const tempParams = {
          prompt: "",
          audio,
          signal
        };
        const transcript = await GroqProvider.generate(tempParams);
        console.log(`[OpenRouter Provider] Audio transcriped successfully: "${transcript}"`);
        userPrompt = `${prompt}
        User voice input: "${transcript}"`;
      } catch (err) {
        console.error("[OpenRouter Provider] Audio transcription fallback failed:", err.message);
        throw new Error("Audio input is not supported on OpenRouter without Groq configuration.");
      }
    }

    // Handle multimodal images
    if (images && images.length > 0) {
      model = "google/gemini-flash-1.5"; // High quality vision fallback on OpenRouter
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

    const response = await openRouter.chat.completions.create(options, { signal });

    if (!response.choices || !response.choices[0] || !response.choices[0].message) {
      throw new Error("Empty response from OpenRouter");
    }

    return response.choices[0].message.content;
  },

  async generateImage({ prompt, style }) {
    throw new Error("OpenRouter does not support native image generation");
  }
};

export default OpenRouterProvider;
