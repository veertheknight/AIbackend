import Groq from "groq-sdk";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured in backend environment.");
  }
  return new Groq({ apiKey });
}

export const GroqProvider = {
  name: "Groq",

  async generate({ prompt, systemInstruction, images, audio, responseMimeType, temperature, history, signal }) {
    const client = getGroqClient();
    let model = "llama-3.3-70b-versatile";
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
    if (audio && audio.data) {
      const buffer = Buffer.from(audio.data, "base64");
      const tempDir = "./uploads";
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempFilePath = `${tempDir}/groq_temp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.m4a`;
      fs.writeFileSync(tempFilePath, buffer);

      try {
        const transcriptionResult = await client.audio.transcriptions.create({
          file: fs.createReadStream(tempFilePath),
          model: "whisper-large-v3",
        }, { signal });

        const transcript = transcriptionResult.text || "";
        userPrompt = `User spoke: "${transcript}". ${prompt}`;
      } finally {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}
      }
    }

    if (images && images.length > 0) {
      model = "llama-3.2-90b-vision-preview";
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
      throw new Error("Empty response returned from Groq API");
    }

    return response.choices[0].message.content || "";
  },
};

export default GroqProvider;
