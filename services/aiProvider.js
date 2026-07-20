import GeminiProvider from "./gemini.js";
import GroqProvider from "./groq.js";
import OpenRouterProvider from "./openrouter.js";

// List of providers in priority order
const providers = [
  GeminiProvider,
  GroqProvider,
  OpenRouterProvider
];

// Local JSON parser to strip markdown blocks and safely parse JSON
function parseSafeJson(text) {
  let cleanText = (text || "").trim();
  try {
    cleanText = cleanText
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

    const firstBrace = cleanText.indexOf("{");
    const firstBracket = cleanText.indexOf("[");

    let start;
    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);

    if (start > 0) cleanText = cleanText.substring(start);

    const lastBrace = cleanText.lastIndexOf("}");
    const lastBracket = cleanText.lastIndexOf("]");

    const end = Math.max(lastBrace, lastBracket);
    if (end !== -1) cleanText = cleanText.substring(0, end + 1);

    return JSON.parse(cleanText);
  } catch (err) {
    try {
      const selfHealed = cleanText.replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(selfHealed);
    } catch (healErr) {
      throw new Error("JSON format mismatch in AI output");
    }
  }
}

// Validator schema check helper
function validateSchema(text, schemaType) {
  if (!schemaType) return true;
  
  let json;
  try {
    json = parseSafeJson(text);
  } catch (e) {
    throw new Error(`JSON parsing failed: ${e.message}`);
  }

  if (schemaType === "pdf") {
    const required = ["summary", "bulletPoints", "chapterSummary", "importantQuestions", "keyPoints"];
    for (const field of required) {
      if (!(field in json)) {
        throw new Error(`Schema validation failed: Missing PDF field "${field}"`);
      }
    }
  } else if (schemaType === "whatsapp") {
    if (!Array.isArray(json) && (!json || !Array.isArray(json.options))) {
      throw new Error(`Schema validation failed: WhatsApp reply options must be array structure`);
    }
  } else if (schemaType === "scam") {
    const required = ["scamProbability", "explanation", "riskFactors", "recommendations"];
    for (const field of required) {
      if (!(field in json)) {
        throw new Error(`Schema validation failed: Missing Scam field "${field}"`);
      }
    }
  } else if (schemaType === "fake-news") {
    const required = ["credibilityScore", "verdict", "explanation", "sources", "bias"];
    for (const field of required) {
      if (!(field in json)) {
        throw new Error(`Schema validation failed: Missing Fake News field "${field}"`);
      }
    }
  } else if (schemaType === "voice") {
    const required = ["transcription", "answer"];
    for (const field of required) {
      if (!(field in json)) {
        throw new Error(`Schema validation failed: Missing Voice field "${field}"`);
      }
    }
  }

  return true;
}

/**
 * Orchestrates AI calls with automatic provider failovers, timeouts, validations and retries.
 */
export async function generate(params) {
  const {
    prompt,
    systemInstruction,
    images,
    audio,
    responseMimeType,
    temperature,
    history,
    schemaType,
    toolName = "AI Tool",
  } = params;

  // 1. Request Validation
  if (!prompt && !audio) {
    throw new Error("Invalid request: Prompt or Audio input must be provided.");
  }
  if (images) {
    for (const img of images) {
      if (!img.data || !img.mimeType) {
        throw new Error("Invalid request: Image payload is missing data or mimeType.");
      }
    }
  }
  if (audio) {
    if (!audio.data || !audio.mimeType) {
      throw new Error("Invalid request: Audio payload is missing data or mimeType.");
    }
  }

  const startTime = Date.now();
  console.log(`[AI Provider Manager] [Incoming Request] Tool: "${toolName}", Prompt Length: ${prompt ? prompt.length : 0}`);

  let lastError = null;

  // 2. Try each provider in sequence
  for (const provider of providers) {
    let attempt = 0;
    const maxRetries = 2; // Total 3 attempts per provider
    const timeoutMs = 25000; // 25 seconds timeout per call

    while (attempt <= maxRetries) {
      attempt++;
      console.log(`[AI Provider Manager] [Attempt ${attempt}] Sending request to provider: "${provider.name}"`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const rawResponse = await provider.generate({
          prompt,
          systemInstruction,
          images,
          audio,
          responseMimeType,
          temperature,
          history,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // 3. Response Validation
        if (!rawResponse || rawResponse.trim().length === 0) {
          throw new Error("Provider returned an empty response.");
        }

        if (responseMimeType === "application/json" || schemaType) {
          validateSchema(rawResponse, schemaType);
        }

        const duration = Date.now() - startTime;
        console.log(`[AI Provider Manager] [Success] Provider: "${provider.name}", Duration: ${duration}ms, Final Provider Used: "${provider.name}"`);

        return rawResponse;
      } catch (err) {
        clearTimeout(timeoutId);
        const isTimeout = controller.signal.aborted || err.name === "AbortError" || err.message.includes("Timeout");
        
        console.warn(`[AI Provider Manager] [Error] Provider: "${provider.name}", Attempt: ${attempt}, Timeout: ${isTimeout}, Error: "${err.message}"`);
        
        lastError = err;

        // If not the final attempt, delay with backoff
        if (attempt <= maxRetries) {
          const delay = 1000 * attempt;
          console.log(`[AI Provider Manager] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.log(`[AI Provider Manager] [Provider Switch] Provider "${provider.name}" exhausted. Switching to next fallback.`);
  }

  console.error(`[AI Provider Manager] [Failure] All providers exhausted. Final error: "${lastError.message}"`);
  throw new Error("All AI services are temporarily unavailable. Please try again shortly.");
}

/**
 * Image generation manager wrapper.
 */
export async function generateImage({ prompt, style }) {
  const startTime = Date.now();
  console.log(`[AI Provider Manager] [Incoming Request] Tool: "Image Generator", Prompt: "${prompt}"`);

  try {
    const base64Bytes = await GeminiProvider.generateImage({ prompt, style });
    const duration = Date.now() - startTime;
    console.log(`[AI Provider Manager] [Success] Image Generator via Gemini, Duration: ${duration}ms`);
    return { base64Bytes };
  } catch (err) {
    console.warn(`[AI Provider Manager] [Failure] Gemini Image Generation failed, invoking fallback: "${err.message}"`);
    // Native self-healing Pollinations AI URL fallback
    const styledPrompt = style ? `A beautiful image in ${style} style: ${prompt}` : prompt;
    const fallbackUrl = `https://image.pollinations.ai/p/${encodeURIComponent(styledPrompt)}?width=600&height=600&nologo=true`;
    return { fallbackUrl };
  }
}

export default {
  generate,
  generateImage
};
