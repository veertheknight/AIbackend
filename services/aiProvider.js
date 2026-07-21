import GeminiProvider from "./gemini.js";
import GroqProvider from "./groq.js";
import OpenRouterProvider from "./openrouter.js";
import OpenAIProvider from "./openai.js";

// Mapping of provider names to their implementations
const providerMap = {
  "Gemini": GeminiProvider,
  "Groq": GroqProvider,
  "OpenRouter": OpenRouterProvider,
  "OpenAI": OpenAIProvider
};

// Tool-specific provider priority orders
const toolPriorities = {
  "Image Generator": ["Gemini", "OpenAI", "OpenRouter", "Groq"],
  "Homework Solver": ["Gemini", "OpenAI", "OpenRouter", "Groq"],
  "Voice Assistant": ["Gemini", "OpenAI", "OpenRouter", "Groq"],
  "Voice Chat": ["Gemini", "OpenAI", "OpenRouter", "Groq"],
  "Image Analyzer": ["Gemini", "OpenAI", "OpenRouter", "Groq"],
  "Resume Builder": ["OpenAI", "Gemini", "OpenRouter", "Groq"],
  "Resume": ["OpenAI", "Gemini", "OpenRouter", "Groq"],
  "Email Writer": ["OpenAI", "OpenRouter", "Groq", "Gemini"],
  "WhatsApp Reply": ["Groq", "OpenRouter", "OpenAI", "Gemini"],
  "Translator": ["Groq", "OpenRouter", "OpenAI", "Gemini"],
  "Code Generator": ["OpenAI", "Gemini", "OpenRouter", "Groq"],
  "Code Assistant": ["OpenAI", "Gemini", "OpenRouter", "Groq"],
  "Code": ["OpenAI", "Gemini", "OpenRouter", "Groq"],
  "PDF Summary": ["OpenRouter", "OpenAI", "Gemini", "Groq"],
  "Scam Detector": ["OpenRouter", "OpenAI", "Gemini", "Groq"],
  "Fake News Detector": ["OpenRouter", "OpenAI", "Gemini", "Groq"]
};

/**
 * 1. Clean and extract valid JSON substring from provider output.
 * Removes ```json fences, ``` fences, trims whitespace, and extracts starting at '{' or '['.
 */
export function cleanAndExtractJson(text) {
  if (!text || typeof text !== "string") return "";
  
  let str = text.trim();

  // Remove markdown code fences ```json ... ``` or ``` ... ```
  str = str.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  str = str.replace(/```json/gi, "").replace(/```/g, "").trim();

  // Find first opening brace or bracket
  const firstBrace = str.indexOf("{");
  const firstBracket = str.indexOf("[");

  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    start = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    start = firstBrace;
  } else if (firstBracket !== -1) {
    start = firstBracket;
  }

  if (start !== -1) {
    const isObject = str[start] === "{";
    const lastMatchingEnd = isObject ? str.lastIndexOf("}") : str.lastIndexOf("]");
    if (lastMatchingEnd !== -1 && lastMatchingEnd > start) {
      str = str.substring(start, lastMatchingEnd + 1);
    } else {
      str = str.substring(start);
    }
  }

  return str.trim();
}

/**
 * 2. Automatic JSON Repair.
 * Tries direct parse, trailing comma removal, quote fixes, and bracket completion.
 */
export function attemptJsonRepair(text) {
  const str = cleanAndExtractJson(text);

  // Attempt 1: Direct JSON.parse
  try {
    return JSON.parse(str);
  } catch (e1) {}

  // Attempt 2: Strip trailing commas inside arrays and objects
  try {
    const fixedCommas = str.replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(fixedCommas);
  } catch (e2) {}

  // Attempt 3: Convert single quotes to double quotes
  try {
    const fixedQuotes = str
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(fixedQuotes);
  } catch (e3) {}

  // Attempt 4: Auto-close unclosed braces or brackets
  try {
    let openBraces = (str.match(/\{/g) || []).length - (str.match(/\}/g) || []).length;
    let openBrackets = (str.match(/\[/g) || []).length - (str.match(/\]/g) || []).length;

    let patched = str;
    while (openBrackets > 0) {
      patched += "]";
      openBrackets--;
    }
    while (openBraces > 0) {
      patched += "}";
      openBraces--;
    }
    patched = patched.replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(patched);
  } catch (e4) {}

  throw new Error("Unable to parse or repair JSON output");
}

/**
 * 3. Shared JSON Schema Validator and Automatic Structure Repair.
 */
export function validateAndRepairSchema(jsonObj, schemaType) {
  if (!schemaType) return jsonObj;

  let json = jsonObj;

  if (schemaType === "whatsapp") {
    // Repair top-level structure if provider returned a raw array
    if (Array.isArray(json)) {
      json = { options: json };
    } else if (json && typeof json === "object") {
      if (!Array.isArray(json.options)) {
        // Look for array under alternative keys (e.g. replies, variations, data)
        const altKey = Object.keys(json).find(k => Array.isArray(json[k]));
        if (altKey) {
          json.options = json[altKey];
        }
      }
    }

    // Validate options exists and is an array
    if (!json || !Array.isArray(json.options) || json.options.length === 0) {
      throw new Error("Validation failed: 'options' must be a non-empty array");
    }

    // Repair items in options array to ensure each item is { tone, reply }
    json.options = json.options.map((item) => {
      if (typeof item === "string") {
        return {
          tone: "friendly",
          reply: item
        };
      } else if (item && typeof item === "object") {
        const replyText = item.reply || item.text || item.message || item.option || item.content || JSON.stringify(item);
        const toneText = item.tone || item.style || "friendly";
        return {
          tone: String(toneText),
          reply: String(replyText)
        };
      }
      return {
        tone: "friendly",
        reply: String(item)
      };
    });

    // Final strict validation check
    for (const opt of json.options) {
      if (typeof opt.tone !== "string" || typeof opt.reply !== "string") {
        throw new Error("Validation failed: Every option must contain tone and reply strings");
      }
    }

    return json;
  }

  if (schemaType === "pdf") {
    if (typeof json !== "object" || !json) throw new Error("Invalid PDF schema: Expected object");
    json.summary = json.summary || "Summary unavailable";
    json.bulletPoints = Array.isArray(json.bulletPoints) ? json.bulletPoints : [];
    json.chapterSummary = Array.isArray(json.chapterSummary) ? json.chapterSummary : [];
    json.importantQuestions = Array.isArray(json.importantQuestions) ? json.importantQuestions : [];
    json.keyPoints = Array.isArray(json.keyPoints) ? json.keyPoints : [];
    return json;
  }

  if (schemaType === "scam") {
    if (typeof json !== "object" || !json) throw new Error("Invalid Scam schema: Expected object");
    json.scamProbability = typeof json.scamProbability === "number" ? json.scamProbability : parseInt(json.scamProbability) || 50;
    json.explanation = json.explanation || "No explanation provided";
    json.riskFactors = Array.isArray(json.riskFactors) ? json.riskFactors : [];
    json.recommendations = Array.isArray(json.recommendations) ? json.recommendations : [];
    return json;
  }

  if (schemaType === "fake-news") {
    if (typeof json !== "object" || !json) throw new Error("Invalid Fake News schema: Expected object");
    json.credibilityScore = typeof json.credibilityScore === "number" ? json.credibilityScore : parseInt(json.credibilityScore) || 50;
    json.verdict = json.verdict || "Unverified";
    json.explanation = json.explanation || "No explanation provided";
    json.sources = Array.isArray(json.sources) ? json.sources : [];
    json.bias = json.bias || "Neutral";
    return json;
  }

  if (schemaType === "voice") {
    if (typeof json !== "object" || !json) throw new Error("Invalid Voice schema: Expected object");
    if (!json.transcription || !json.answer) throw new Error("Voice schema missing transcription or answer");
    return json;
  }

  return json;
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
  
  // Resolve priority list for the selected tool (defaults to Gemini -> OpenAI -> OpenRouter -> Groq)
  const priorityList = toolPriorities[toolName] || ["Gemini", "OpenAI", "OpenRouter", "Groq"];
  const activeProviders = priorityList.map(name => providerMap[name]).filter(Boolean);

  console.log(`[AI Provider Manager] [Incoming Request]`);
  console.log(`  - Selected Tool: "${toolName}"`);
  console.log(`  - Selected Provider Order: ${priorityList.join(" -> ")}`);
  console.log(`  - Cache: Miss`);

  let lastError = null;

  // Try each provider in the resolved priority list
  for (let i = 0; i < activeProviders.length; i++) {
    const provider = activeProviders[i];
    const fallbackProvider = activeProviders[i + 1];
    const fallbackName = fallbackProvider ? fallbackProvider.name : "None";

    let attempt = 0;
    const maxRetries = 2; // Attempt 1 + 1-time regeneration retry before provider switch
    const timeoutMs = 25000; // 25s timeout

    while (attempt < maxRetries) {
      attempt++;
      console.log(`[AI Provider Manager] [Attempt ${attempt}] Current Provider: "${provider.name}"`);
      console.log(`  - Fallback Provider: "${fallbackName}"`);

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

        // Check empty response
        if (!rawResponse || rawResponse.trim().length === 0) {
          throw new Error("Provider returned an empty response.");
        }

        // Validate & Repair JSON & Schema
        let finalOutput = rawResponse;
        if (responseMimeType === "application/json" || schemaType) {
          const parsedJson = attemptJsonRepair(rawResponse);
          const repairedJson = validateAndRepairSchema(parsedJson, schemaType);
          finalOutput = JSON.stringify(repairedJson);
        }

        const duration = Date.now() - startTime;
        console.log(`[AI Provider Manager] [Success]`);
        console.log(`  - Final Provider Used: "${provider.name}"`);
        console.log(`  - Provider Duration: ${duration}ms`);

        return finalOutput;
      } catch (err) {
        clearTimeout(timeoutId);
        const isTimeout = controller.signal?.aborted || err.name === "AbortError" || err.message.includes("Timeout");
        
        console.warn(`[AI Provider Manager] [Failure] Provider: "${provider.name}", Attempt: ${attempt}, Timeout: ${isTimeout}, Error: "${err.message}"`);
        lastError = err;

        if (attempt < maxRetries) {
          console.log(`[AI Provider Manager] Parsing/Schema failed for "${provider.name}". Attempting 1-time regeneration...`);
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      }
    }

    if (fallbackProvider) {
      console.log(`[AI Provider Manager] [Provider Switch] Switching to "${fallbackName}"`);
    }
  }

  console.error(`[AI Provider Manager] [Failure] All providers exhausted. Final error: "${lastError?.message}"`);
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
    const styledPrompt = style ? `A beautiful image in ${style} style: ${prompt}` : prompt;
    const fallbackUrl = `https://image.pollinations.ai/p/${encodeURIComponent(styledPrompt)}?width=600&height=600&nologo=true`;
    return { fallbackUrl };
  }
}

export default {
  generate,
  generateImage,
  cleanAndExtractJson,
  attemptJsonRepair,
  validateAndRepairSchema
};
