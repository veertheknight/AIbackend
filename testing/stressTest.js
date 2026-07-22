import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ----------------------------------------------------
// Parse CLI Arguments & Environment Variables
// ----------------------------------------------------
const cliArgs = {};
process.argv.slice(2).forEach(arg => {
  const cleanArg = arg.replace(/^--/, "");
  const equalsIdx = cleanArg.indexOf("=");
  if (equalsIdx !== -1) {
    const key = cleanArg.substring(0, equalsIdx).toUpperCase();
    const value = cleanArg.substring(equalsIdx + 1);
    cliArgs[key] = value;
  }
});

// Top Configuration Variables with Windows & Cross-Platform Support
export const CONFIG = {
  BACKEND_URL: cliArgs.BACKEND_URL || cliArgs.URL || process.env.BACKEND_URL || "https://aibackend-nuqf.onrender.com",
  ROUTE: cliArgs.ROUTE || process.env.ROUTE || "/api/ai/homework",
  PROMPT: cliArgs.PROMPT || process.env.PROMPT || "Explain Newton's Second Law of Motion in simple terms.",
  NUMBER_OF_REQUESTS: Number(cliArgs.NUMBER_OF_REQUESTS || cliArgs.REQUESTS || process.env.NUMBER_OF_REQUESTS) || 20,
  CONCURRENT_REQUESTS: Number(cliArgs.CONCURRENT_REQUESTS || cliArgs.CONCURRENCY || process.env.CONCURRENT_REQUESTS) || 3,
  DELAY_BETWEEN_REQUESTS: Number(cliArgs.DELAY_BETWEEN_REQUESTS || cliArgs.DELAY || process.env.DELAY_BETWEEN_REQUESTS) || 300, // ms
  TIMEOUT: Number(cliArgs.TIMEOUT || process.env.TIMEOUT) || 30000, // 30s
  USER_UID: cliArgs.USER_UID || process.env.USER_UID || "guest_stress_tester"
};

// ----------------------------------------------------
// Terminal Color Formatting Helpers
// ----------------------------------------------------
const COLORS = {
  green: (txt) => `\x1b[32m${txt}\x1b[0m`,
  yellow: (txt) => `\x1b[33m${txt}\x1b[0m`,
  blue: (txt) => `\x1b[34m${txt}\x1b[0m`,
  red: (txt) => `\x1b[31m${txt}\x1b[0m`,
  cyan: (txt) => `\x1b[36m${txt}\x1b[0m`,
  bold: (txt) => `\x1b[1m${txt}\x1b[0m`
};

// ----------------------------------------------------
// Global State Records
// ----------------------------------------------------
const records = [];
let isStopping = false;

const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalResponseTime: 0,
  fastestResponse: Infinity,
  slowestResponse: 0,
  providersUsed: {
    gemini: 0,
    groq: 0,
    openrouter: 0,
    openai: 0,
    unknown: 0
  },
  cacheHits: 0,
  cacheMisses: 0,
  errors429: 0,
  errors500: 0,
  timeouts: 0,
  firstFailedRequestNum: null,
  firstFailureReason: null
};

// Handle Ctrl+C safely
process.on("SIGINT", () => {
  console.log("\n" + COLORS.yellow("⚠️  Received SIGINT (Ctrl+C). Stopping stress test early and saving report..."));
  isStopping = true;
  generateAndSaveReport();
  process.exit(0);
});

/**
 * Executes a single request and returns metric object.
 */
async function executeRequest(requestNumber) {
  if (isStopping) return null;

  const fullUrl = `${CONFIG.BACKEND_URL.replace(/\/$/, "")}${CONFIG.ROUTE}`;
  const startTime = Date.now();
  let endTime = 0;
  let statusCode = 0;
  let success = false;
  let errorMsg = null;
  let providerUsed = "unknown";
  let isCacheHit = false;

  try {
    const payload = {
      question: `${CONFIG.PROMPT} (Req #${requestNumber})`,
      message: `${CONFIG.PROMPT} (Req #${requestNumber})`,
      purpose: `${CONFIG.PROMPT} (Req #${requestNumber})`,
      prompt: `${CONFIG.PROMPT} (Req #${requestNumber})`,
      text: `${CONFIG.PROMPT} (Req #${requestNumber})`,
      targetLanguage: "Spanish",
      action: "generate",
      imageBase64: null
    };

    const response = await axios.post(fullUrl, payload, {
      headers: {
        "x-user-uid": CONFIG.USER_UID,
        "Content-Type": "application/json"
      },
      timeout: CONFIG.TIMEOUT
    });

    endTime = Date.now();
    statusCode = response.status;
    success = true;

    // Detect provider used from response header or payload
    const pHeader = (response.headers["x-provider-used"] || response.data?.provider || "").toLowerCase();
    if (pHeader.includes("gemini")) providerUsed = "gemini";
    else if (pHeader.includes("groq")) providerUsed = "groq";
    else if (pHeader.includes("openrouter")) providerUsed = "openrouter";
    else if (pHeader.includes("openai")) providerUsed = "openai";

    // Detect cache hit
    if (response.headers["x-cache-hit"] === "true" || response.data?.cached) {
      isCacheHit = true;
    }

    const duration = endTime - startTime;
    console.log(COLORS.green(`[SUCCESS] Request #${requestNumber} (${duration}ms) - Status: ${statusCode}`));

  } catch (err) {
    endTime = Date.now();
    success = false;

    if (err.response) {
      statusCode = err.response.status;
      errorMsg = err.response.data?.error || err.response.statusText || err.message;
    } else if (err.code === "ECONNABORTED" || err.message.toLowerCase().includes("timeout")) {
      statusCode = 408;
      errorMsg = "Request Timeout";
    } else {
      statusCode = 500;
      errorMsg = err.message;
    }

    const duration = endTime - startTime;
    console.log(COLORS.red(`[FAILURE] Request #${requestNumber} (${duration}ms) - Status: ${statusCode} - Error: "${errorMsg}"`));
  }

  const duration = endTime - startTime;

  // Aggregate metrics
  metrics.totalRequests++;
  if (success) {
    metrics.successfulRequests++;
    metrics.totalResponseTime += duration;
    if (duration < metrics.fastestResponse) metrics.fastestResponse = duration;
    if (duration > metrics.slowestResponse) metrics.slowestResponse = duration;

    if (isCacheHit) metrics.cacheHits++;
    else metrics.cacheMisses++;

    metrics.providersUsed[providerUsed] = (metrics.providersUsed[providerUsed] || 0) + 1;
  } else {
    metrics.failedRequests++;
    if (statusCode === 429) metrics.errors429++;
    if (statusCode >= 500) metrics.errors500++;
    if (statusCode === 408 || (errorMsg && errorMsg.toLowerCase().includes("timeout"))) metrics.timeouts++;

    if (metrics.firstFailedRequestNum === null) {
      metrics.firstFailedRequestNum = requestNumber;
      metrics.firstFailureReason = errorMsg;
    }

    if (errorMsg && errorMsg.includes("All AI services are temporarily unavailable")) {
      console.log(COLORS.bold(COLORS.red("\nAll providers exhausted. Halting test suite.\n")));
      isStopping = true;
    }
  }

  const record = {
    requestNumber,
    startTime,
    endTime,
    responseTime: duration,
    statusCode,
    providerUsed,
    success,
    failure: !success,
    errorMessage: errorMsg
  };

  records.push(record);
  return record;
}

/**
 * Main Stress Test Runner.
 */
export async function runStressTest() {
  console.log(COLORS.bold(COLORS.cyan("\n==============================================")));
  console.log(COLORS.bold(COLORS.cyan("      Lumina AI Standalone Stress Tester      ")));
  console.log(COLORS.bold(COLORS.cyan("==============================================\n")));

  console.log(`Backend URL:        ${CONFIG.BACKEND_URL}`);
  console.log(`Target Route:       ${CONFIG.ROUTE}`);
  console.log(`Total Requests:     ${CONFIG.NUMBER_OF_REQUESTS}`);
  console.log(`Concurrency Limit:  ${CONFIG.CONCURRENT_REQUESTS}`);
  console.log(`Delay Between:      ${CONFIG.DELAY_BETWEEN_REQUESTS}ms`);
  console.log(`Request Timeout:    ${CONFIG.TIMEOUT}ms\n`);

  const startTime = Date.now();
  let currentReq = 1;

  while (currentReq <= CONFIG.NUMBER_OF_REQUESTS && !isStopping) {
    const batch = [];
    for (let i = 0; i < CONFIG.CONCURRENT_REQUESTS && currentReq <= CONFIG.NUMBER_OF_REQUESTS; i++) {
      batch.push(executeRequest(currentReq++));
    }

    await Promise.all(batch);

    if (CONFIG.DELAY_BETWEEN_REQUESTS > 0 && currentReq <= CONFIG.NUMBER_OF_REQUESTS && !isStopping) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_REQUESTS));
    }
  }

  generateAndSaveReport();
}

/**
 * Formats and exports JSON & TXT stress reports.
 */
function generateAndSaveReport() {
  const avgResponseTime = metrics.successfulRequests > 0
    ? (metrics.totalResponseTime / metrics.successfulRequests).toFixed(2)
    : 0;

  const successRate = metrics.totalRequests > 0
    ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
    : 0;

  const failureRate = metrics.totalRequests > 0
    ? ((metrics.failedRequests / metrics.totalRequests) * 100).toFixed(2)
    : 0;

  const totalSuccessfulProviders = Object.values(metrics.providersUsed).reduce((a, b) => a + b, 0) || 1;

  const providerPercentages = {
    Gemini: `${((metrics.providersUsed.gemini / totalSuccessfulProviders) * 100).toFixed(1)}%`,
    Groq: `${((metrics.providersUsed.groq / totalSuccessfulProviders) * 100).toFixed(1)}%`,
    OpenRouter: `${((metrics.providersUsed.openrouter / totalSuccessfulProviders) * 100).toFixed(1)}%`,
    OpenAI: `${((metrics.providersUsed.openai / totalSuccessfulProviders) * 100).toFixed(1)}%`
  };

  const reportTxt = `
========================
AI Stress Test Report
========================
Total Requests: ${metrics.totalRequests}
Successful Requests: ${metrics.successfulRequests}
Failed Requests: ${metrics.failedRequests}
Success Rate: ${successRate}%
Failure Rate: ${failureRate}%
Average Response Time: ${avgResponseTime}ms
Fastest Response: ${metrics.fastestResponse === Infinity ? 0 : metrics.fastestResponse}ms
Slowest Response: ${metrics.slowestResponse}ms

Provider Usage Percentages:
- Gemini: ${providerPercentages.Gemini}
- Groq: ${providerPercentages.Groq}
- OpenRouter: ${providerPercentages.OpenRouter}
- OpenAI: ${providerPercentages.OpenAI}

Cache Hits: ${metrics.cacheHits}
Cache Misses: ${metrics.cacheMisses}
429 Errors: ${metrics.errors429}
500 Errors: ${metrics.errors500}
Timeouts: ${metrics.timeouts}
First Failed Request Number: ${metrics.firstFailedRequestNum ?? "None"}
Failure Reason: ${metrics.firstFailureReason ?? "None"}
========================
`;

  console.log(COLORS.bold(COLORS.cyan(reportTxt)));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const jsonPath = path.join(__dirname, "stress-report.json");
  const txtPath = path.join(__dirname, "stress-report.txt");

  const reportObj = {
    config: CONFIG,
    metrics: {
      totalRequests: metrics.totalRequests,
      successfulRequests: metrics.successfulRequests,
      failedRequests: metrics.failedRequests,
      successRate: `${successRate}%`,
      failureRate: `${failureRate}%`,
      averageResponseTimeMs: avgResponseTime,
      fastestResponseMs: metrics.fastestResponse === Infinity ? 0 : metrics.fastestResponse,
      slowestResponseMs: metrics.slowestResponse,
      providerPercentages,
      cacheHits: metrics.cacheHits,
      cacheMisses: metrics.cacheMisses,
      errors429: metrics.errors429,
      errors500: metrics.errors500,
      timeouts: metrics.timeouts,
      firstFailedRequestNumber: metrics.firstFailedRequestNum,
      failureReason: metrics.firstFailureReason
    },
    records
  };

  fs.writeFileSync(jsonPath, JSON.stringify(reportObj, null, 2));
  fs.writeFileSync(txtPath, reportTxt.trim());

  console.log(COLORS.green(`\nReport successfully saved to:`));
  console.log(COLORS.cyan(`- ${jsonPath}`));
  console.log(COLORS.cyan(`- ${txtPath}\n`));
}

// Auto-start if executed directly from CLI
if (process.argv[1] && process.argv[1].includes("stressTest.js")) {
  runStressTest();
}