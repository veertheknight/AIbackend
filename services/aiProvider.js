import GeminiProvider from "./gemini.js";
import OpenAIProvider from "./openai.js";
import OpenRouterProvider from "./openrouter.js";
import GroqProvider from "./groq.js";
import { getToolProviderPriority, getProviderTimeout } from "./providerConfig.js";
import { startRequest, finishSuccess, finishFailure } from "./providerHealth.js";

const providerMap = {
  "gemini": GeminiProvider,
  "openai": OpenAIProvider,
  "openrouter": OpenRouterProvider,
  "groq": GroqProvider,
};

/**
  1. Clean and extract valid JSON substring from provider output.
 */
export function cleanAndExtractJson(text) {
  if (!text || typeof text !== "string") return "";
  let str = text.trim();
  str = str.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  str = str.replace(/```json/gi, "").replace(/```/g, "").trim();

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
  2. Automatic JSON Repair.
 */
export function attemptJsonRepair(text) {
  const str = cleanAndExtractJson(text);

  try {
    return JSON.parse(str);
  } catch {}

  try {
    const fixedCommas = str.replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(fixedCommas);
  } catch {}

  try {
    const fixedQuotes = str
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
      .replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(fixedQuotes);
  } catch {}

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
  } catch {}

  throw new Error("Unable to parse or repair JSON output");
}

/**
  3. Shared JSON Schema Validator and Automatic Structure Repair.
 */
export function validateAndRepairSchema(jsonObj, schemaType) {
  if (!schemaType) return jsonObj;
  let json = jsonObj;

  if (schemaType === "whatsapp") {
    if (Array.isArray(json)) {
      json = { options: json };
    } else if (json && typeof json === "object") {
      if (!Array.isArray(json.options)) {
        const altKey = Object.keys(json).find(k => Array.isArray(json[k]));
        if (altKey) {
          json.options = json[altKey];
        }
      }
    }
    if (!json || !Array.isArray(json.options) || json.options.length === 0) {
      throw new Error("Validation failed: 'options' must be a non-empty array");
    }
    json.options = json.options.map((item) => {
      if (typeof item === "string") {
        return { tone: "friendly", reply: item };
      } else if (item && typeof item === "object") {
        const replyText = item.reply || item.text || item.message || item.option || item.content || JSON.stringify(item);
        const toneText = item.tone || item.style || "friendly";
        return { tone: String(toneText), reply: String(replyText) };
      }
      return { tone: "friendly", reply: String(item) };
    });
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

// Request Queueing for Concurrency Control
const maxConcurrentRequests = 6;
let activeRequestCount = 0;
const requestQueue = [];

function processNextInQueue() {
  if (activeRequestCount < maxConcurrentRequests && requestQueue.length > 0) {
    const nextTask = requestQueue.shift();
    if (nextTask) nextTask();
  }
}

function queueRequest(task) {
  return new Promise((resolve, reject) => {
    const runner = async () => {
      activeRequestCount++;
      try {
        const result = await task();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        activeRequestCount--;
        processNextInQueue();
      }
    };

    if (activeRequestCount < maxConcurrentRequests) {
      runner();
    } else {
      requestQueue.push(runner);
    }
  });
}

/**
 * Orchestrates AI requests with completely independent sessions per request,
 * multi-provider fallback cascade, exponential retries, request timeout handling,
 * and structured logging.
 */
export async function generate(params) {
  return queueRequest(() => executeGenerate(params));
}

async function executeGenerate(params) {
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
    userType = "Signed In",
    res
  } = params;

  if (!prompt && !audio) {
    throw new Error("Invalid request: Prompt or Audio input must be provided.");
  }

  const startTime = Date.now();
  const priorityList = getToolProviderPriority(toolName);
  const attemptedProviders = [];
  let fallbackCount = 0;
  let lastError = null;

  console.log(`\n==================================================`);
  console.log(`[AI Provider Router] NEW FRESH REQUEST`);
  console.log(`  • Tool Name: "${toolName}"`);
  console.log(`  • Priority Cascade: ${priorityList.join(" ➔ ")}`);
  console.log(`  • Timestamp: ${new Date().toISOString()}`);
  console.log(`==================================================`);

  for (let i = 0; i < priorityList.length; i++) {
    const providerKey = priorityList[i].toLowerCase();
    const providerObj = providerMap[providerKey];

    if (!providerObj) {
      continue;
    }

    attemptedProviders.push(providerKey);
    startRequest(providerKey);

    const timeoutMs = getProviderTimeout(providerKey);
    const maxRetries = 2; // Up to 2 attempts per provider

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const pStartTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const rawResponse = await providerObj.generate({
          prompt,
          systemInstruction,
          images,
          audio,
          responseMimeType,
          temperature,
          history,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!rawResponse || typeof rawResponse !== "string" || rawResponse.trim().length === 0) {
          throw new Error(`Empty text response returned from provider "${providerKey}"`);
        }

        // Parse & Repair JSON if requested
        let finalOutput = rawResponse;
        if (responseMimeType === "application/json" || schemaType) {
          const parsedJson = attemptJsonRepair(rawResponse);
          const repairedJson = validateAndRepairSchema(parsedJson, schemaType);
          finalOutput = JSON.stringify(repairedJson);
        }

        const pDuration = Date.now() - pStartTime;
        const totalDuration = Date.now() - startTime;
        const responseLength = finalOutput.length;

        finishSuccess(providerKey, pDuration);

        if (res && typeof res.setHeader === "function") {
          res.setHeader("X-AI-Provider", providerKey);
          res.setHeader("X-Provider-Used", providerKey);
        }

        // STRUCTURED LOGGING
        console.log(`\n[AI Provider Router] ✅ REQUEST SUCCESSFUL`);
        console.log(`  • Tool Name: "${toolName}"`);
        console.log(`  • Selected Provider: "${providerKey}"`);
        console.log(`  • Fallback Count: ${fallbackCount}`);
        console.log(`  • Attempt Number: ${attempt}`);
        console.log(`  • Latency: ${totalDuration}ms (Provider: ${pDuration}ms)`);
        console.log(`  • Token/Character Count: ${responseLength} chars`);
        console.log(`  • Providers Attempted: [${attemptedProviders.join(", ")}]`);
        console.log(`  • Status: SUCCESS\n`);

        return finalOutput;

      } catch (err) {
        clearTimeout(timeoutId);
        const pDuration = Date.now() - pStartTime;
        finishFailure(providerKey, err.message);
        lastError = err;

        console.warn(`[AI Provider Router] ⚠️ Attempt ${attempt}/${maxRetries} failed on provider "${providerKey}" for tool "${toolName}". Duration: ${pDuration}ms. Error: ${err.message}`);

        // If attempt < maxRetries, apply exponential backoff before retrying same provider
        if (attempt < maxRetries) {
          const backoffMs = 500 * Math.pow(2, attempt - 1);
          console.log(`[AI Provider Router] Retrying provider "${providerKey}" in ${backoffMs}ms...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      }
    }

    // Provider failed after all retries -> increment fallback count and cascade to next provider
    fallbackCount++;
    const nextProvider = priorityList[i + 1] ? priorityList[i + 1] : "None";
    console.warn(`[AI Provider Router] 🔄 FALLBACK TRIGGERED: Provider "${providerKey}" exhausted for tool "${toolName}". Switching to fallback "${nextProvider}".`);
  }

  // All providers failed
  const totalDuration = Date.now() - startTime;
  console.error(`\n[AI Provider Router] ❌ ALL PROVIDERS EXHAUSTED`);
  console.error(`  • Tool Name: "${toolName}"`);
  console.error(`  • Total Fallback Count: ${fallbackCount}`);
  console.error(`  • Providers Attempted: [${attemptedProviders.join(", ")}]`);
  console.error(`  • Total Latency: ${totalDuration}ms`);
  console.error(`  • Final Error: "${lastError?.message}"`);
  console.error(`  • Status: FAILURE\n`);

  throw new Error(`All AI services (${attemptedProviders.join(", ")}) failed for ${toolName}. Reason: ${lastError?.message || "Service timeout"}`);
}

export default {
  generate,
  cleanAndExtractJson,
  attemptJsonRepair,
  validateAndRepairSchema,
};
