import Groq from "groq-sdk";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

let groq = null;
if (process.env.GROQ_API_KEY) {
  groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });
}

export const GroqProvider = {
  name: "Groq",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history, signal }) {
    if (!groq) {
      throw new Error("Groq API key not configured");
    }

    let model = "llama-3.3-70b-versatile";
    let messages = [];

    if (systemInstruction) {
      messages.push({ role: "system", content: systemInstruction });
    }

    // Map history to OpenAI/Groq standard role/content format
    if (history && history.length > 0) {
      for (const h of history) {
        const role = h.role === "model" ? "assistant" : "user";
        // Extract text parts
        const content = h.parts.map(p => p.text).join("\n");
        messages.push({ role, content });
      }
    }

    // Handle audio input: transcribe audio first, then feed text into prompt
    let userPrompt = prompt;
    if (audio) {
      console.log("[Groq Provider] Transcribing audio via whisper-large-v3...");
      const buffer = Buffer.from(audio.data, "base64");
      const tempDir = "./uploads";
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempFilePath = `${tempDir}/groq_temp_${Date.now()}.m4a`;
      fs.writeFileSync(tempFilePath, buffer);

      try {
        const transcriptionResult = await groq.audio.transcriptions.create({
          file: fs.createReadStream(tempFilePath),
          model: "whisper-large-v3",
        }, { signal });

        const transcript = transcriptionResult.text || "";
        console.log(`[Groq Provider] Transcription result: "${transcript}"`);

        // If it expects JSON (like voice assistant output transcription + answer), format request
        if (responseMimeType === "application/json") {
          userPrompt = `${prompt}
          User voice input: "${transcript}"`;
        } else {
          userPrompt = `The user spoke: "${transcript}". ${prompt}`;
        }
      } finally {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {}
      }
    }

    // Handle multimodal images
    if (images && images.length > 0) {
      model = "llama-3.2-90b-vision-preview";
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

    const chatCompletion = await groq.chat.completions.create(options, { signal });

    if (!chatCompletion.choices || !chatCompletion.choices[0] || !chatCompletion.choices[0].message) {
      throw new Error("Empty response from Groq");
    }

    return chatCompletion.choices[0].message.content;
  },

  async generateImage({ prompt, style }) {
    throw new Error("Groq does not support native image generation");
  }
};

export default GroqProvider;
