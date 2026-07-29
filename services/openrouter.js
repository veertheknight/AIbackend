import OpenAI from "openai";
import dotenv from "dotenv";
import GroqProvider from "./groq.js";

dotenv.config();

function getOpenRouterClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured in backend environment.");
  }
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    defaultHeaders: {
      "HTTP-Referer": "https://zenix.app",
      "X-Title": "Zenix AI App",
    }
  });
}

export const OpenRouterProvider = {
  name: "OpenRouter",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history, signal }) {
    const client = getOpenRouterClient();
    let model = "meta-llama/llama-3.3-70b-instruct";
    let messages = [];

    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }

    if (history && history.length > 0) {
      for (const h of history) {
        const role = h.role === "model" ? "assistant" : "user";
        const content = (h.parts || []).map(p => p.text || "").join("\n");
        messages.push({ role, content });
      }
    }

    let userPrompt = prompt || "";
    if (audio) {
      try {
        const transcript = await GroqProvider.generate({ prompt: "", audio, signal });
        userPrompt = `${prompt}\nUser voice input: "${transcript}"`;
      } catch {
        throw new Error("Audio input is not supported on OpenRouter without Groq configuration.");
      }
    }

    if (images && images.length > 0) {
      model = "google/gemini-flash-1.5";
      const contents = [{ type: "text", text: userPrompt }];
      for (const img of images) {
        if (img.data) {
          contents.push({
            type: "image_url",
            image_url: {
              url: `data:${img.mimeType || "image/jpeg"};base64,${img.data}`,
            },
          });
        }
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

    const response = await client.chat.completions.create(options, { signal });

    if (!response || !response.choices || !response.choices[0] || !response.choices[0].message) {
      throw new Error("Empty response returned from OpenRouter API");
    }

    return response.choices[0].message.content || "";
  },
};

export default OpenRouterProvider;
