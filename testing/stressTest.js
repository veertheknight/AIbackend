import axios from "axios";
import fs from "fs";
import path from "path";
import readline from "readline";
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

// ----------------------------------------------------
// Global Configuration
// ----------------------------------------------------
export const CONFIG = {
  BACKEND_URL: cliArgs.BACKEND_URL || cliArgs.URL || process.env.BACKEND_URL || "https://aibackend-nuqf.onrender.com",
  ROUTE: cliArgs.ROUTE || process.env.ROUTE || "/api/ai/homework",
  TEST_MODE: (cliArgs.TEST_MODE || cliArgs.MODE || process.env.TEST_MODE || "concurrent").toLowerCase(), // sequential | concurrent | burst | ramp | rpm
  TEST_DURATION_SECONDS: Number(cliArgs.TEST_DURATION_SECONDS || cliArgs.DURATION || process.env.TEST_DURATION_SECONDS) || 60,
  TOTAL_REQUESTS: Number(cliArgs.TOTAL_REQUESTS || cliArgs.REQUESTS || process.env.TOTAL_REQUESTS) || 100,
  CONCURRENT_USERS: Number(cliArgs.CONCURRENT_USERS || cliArgs.CONCURRENCY || process.env.CONCURRENT_USERS) || 10,
  RAMP_STEP: Number(cliArgs.RAMP_STEP || process.env.RAMP_STEP) || 5,
  RAMP_INTERVAL: Number(cliArgs.RAMP_INTERVAL || process.env.RAMP_INTERVAL) || 5, // seconds before increasing concurrency
  TIMEOUT: Number(cliArgs.TIMEOUT || process.env.TIMEOUT) || 30000, // 30s
  DELAY: Number(cliArgs.DELAY || process.env.DELAY) || 100, // ms delay between requests
  USER_UID: cliArgs.USER_UID || process.env.USER_UID || "load_test_suite_user",
  PROMPT: cliArgs.PROMPT || process.env.PROMPT || "Explain Newton's Second Law of Motion in simple terms."
};

// ----------------------------------------------------
// Terminal Color Formatting Helpers
// ----------------------------------------------------
const COLORS = {
  green: (txt) => `\x1b[32m${txt}\x1b[0m`,
  yellow: (txt) => `\x1b[33m${txt}\x1b[0m`,
  blue: (txt) => `\x1b[34m${txt}\x1b[0m`,
  red: (txt) => `\x1b[31m${txt}\x1b[0m`,
  purple: (txt) => `\x1b[35m${txt}\x1b[0m`,
  cyan: (txt) => `\x1b[36m${txt}\x1b[0m`,
  bold: (txt) => `\x1b[1m${txt}\x1b[0m`
};

// ----------------------------------------------------
// Global Metrics & State
// ----------------------------------------------------
const requestLogs = [];
let isStopping = false;
let stopReason = "Test Completed";
let consecutiveFailures = 0;
let dashboardIntervalId = null;

const suiteMetrics = {
  startTime: 0,
  endTime: 0,
  totalSent: 0,
  successful: 0,
  failed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalLatencyMs: 0,
  fastestLatency: Infinity,
  slowestLatency: 0,
  peakRps: 0,
  rollingRpsHistory: [],
  providerStats: {
    gemini: { requests: 0, successes: 0, failures: 0, totalLatency: 0, fastest: Infinity, slowest: 0 },
    groq: { requests: 0, successes: 0, failures: 0, totalLatency: 0, fastest: Infinity, slowest: 0 },
    openrouter: { requests: 0, successes: 0, failures: 0, totalLatency: 0, fastest: Infinity, slowest: 0 },
    openai: { requests: 0, successes: 0, failures: 0, totalLatency: 0, fastest: Infinity, slowest: 0 },
    unknown: { requests: 0, successes: 0, failures: 0, totalLatency: 0, fastest: Infinity, slowest: 0 }
  },
  failureBreakdown: {
    err429: 0,
    err500: 0,
    timeout: 0,
    networkError: 0,
    jsonError: 0,
    authError: 0,
    providerExhausted: 0,
    other: 0
  }
};

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log("\n" + COLORS.yellow("⚠️ Received SIGINT (Ctrl+C). Halting load test suite and building final report..."));
  isStopping = true;
  stopReason = "User Aborted (Ctrl+C)";
  finishAndReport();
  process.exit(0);
});

/**
 * Helper to detect provider from response headers or data
 */
function detectProvider(response) {
  if (!response) return "unknown";
  const pHeader = (
    response.headers?.["x-provider-used"] ||
    response.headers?.["x-provider"] ||
    response.data?.provider ||
    response.data?.providerUsed ||
    ""
  ).toLowerCase();

  if (pHeader.includes("gemini")) return "gemini";
  if (pHeader.includes("groq")) return "groq";
  if (pHeader.includes("openrouter")) return "openrouter";
  if (pHeader.includes("openai")) return "openai";

  const strBody = JSON.stringify(response.data || "").toLowerCase();
  if (strBody.includes("gemini")) return "gemini";
  if (strBody.includes("groq")) return "groq";
  if (strBody.includes("openrouter")) return "openrouter";
  if (strBody.includes("openai")) return "openai";

  return "unknown";
}

/**
 * Sends a single HTTP request to the backend and records metrics.
 */
async function sendSingleRequest(reqId) {
  if (isStopping) return null;

  const fullUrl = `${CONFIG.BACKEND_URL.replace(/\/$/, "")}${CONFIG.ROUTE}`;
  const startTime = Date.now();
  let endTime = 0;
  let statusCode = 0;
  let success = false;
  let errorMsg = null;
  let provider = "unknown";
  let isCacheHit = false;

  const payload = {
    question: `${CONFIG.PROMPT} (Load Test #${reqId})`,
    message: `${CONFIG.PROMPT} (Load Test #${reqId})`,
    purpose: `${CONFIG.PROMPT} (Load Test #${reqId})`,
    prompt: `${CONFIG.PROMPT} (Load Test #${reqId})`,
    text: `${CONFIG.PROMPT} (Load Test #${reqId})`,
    targetLanguage: "Spanish",
    action: "generate",
    imageBase64: null
  };

  try {
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
    consecutiveFailures = 0;

    provider = detectProvider(response);
    if (response.headers?.["x-cache-hit"] === "true" || response.data?.cached) {
      isCacheHit = true;
    }

  } catch (err) {
    endTime = Date.now();
    success = false;
    consecutiveFailures++;

    if (err.response) {
      statusCode = err.response.status;
      errorMsg = err.response.data?.error || err.response.statusText || err.message;
      if (statusCode === 401 || statusCode === 403) suiteMetrics.failureBreakdown.authError++;
      else if (statusCode === 429) suiteMetrics.failureBreakdown.err429++;
      else if (statusCode >= 500) suiteMetrics.failureBreakdown.err500++;
    } else if (err.code === "ECONNABORTED" || err.message.toLowerCase().includes("timeout")) {
      statusCode = 408;
      errorMsg = "Request Timeout";
      suiteMetrics.failureBreakdown.timeout++;
    } else {
      statusCode = 500;
      errorMsg = err.message;
      suiteMetrics.failureBreakdown.networkError++;
    }

    if (errorMsg && errorMsg.includes("All AI services are temporarily unavailable")) {
      suiteMetrics.failureBreakdown.providerExhausted++;
      console.log("\n" + COLORS.bold(COLORS.red("❌ All AI providers exhausted on backend! Halting suite.")));
      isStopping = true;
      stopReason = "All Providers Exhausted";
    } else if (errorMsg && (errorMsg.includes("JSON") || errorMsg.includes("SyntaxError"))) {
      suiteMetrics.failureBreakdown.jsonError++;
    }

    if (consecutiveFailures >= 50) {
      console.log("\n" + COLORS.bold(COLORS.red("❌ Reached 50 consecutive failures. Halting suite.")));
      isStopping = true;
      stopReason = "50 Consecutive Failures Reached";
    }
  }

  const duration = endTime - startTime;
  suiteMetrics.totalSent++;

  const pStats = suiteMetrics.providerStats[provider] || suiteMetrics.providerStats.unknown;
  pStats.requests++;

  if (success) {
    suiteMetrics.successful++;
    suiteMetrics.totalLatencyMs += duration;
    if (duration < suiteMetrics.fastestLatency) suiteMetrics.fastestLatency = duration;
    if (duration > suiteMetrics.slowestLatency) suiteMetrics.slowestLatency = duration;

    pStats.successes++;
    pStats.totalLatency += duration;
    if (duration < pStats.fastest) pStats.fastest = duration;
    if (duration > pStats.slowest) pStats.slowest = duration;

    if (isCacheHit) suiteMetrics.cacheHits++;
    else suiteMetrics.cacheMisses++;

    console.log(COLORS.green(`✔ Req #${reqId} (${duration}ms) [${provider.toUpperCase()}] - Status ${statusCode}`));
  } else {
    suiteMetrics.failed++;
    pStats.failures++;
    console.log(COLORS.red(`✘ Req #${reqId} (${duration}ms) - Status ${statusCode} - Error: "${errorMsg}"`));
  }

  const logEntry = {
    reqId,
    startTime,
    endTime,
    duration,
    statusCode,
    success,
    provider,
    isCacheHit,
    errorMsg
  };

  requestLogs.push(logEntry);
  return logEntry;
}

/**
 * Continuously renders live load test dashboard in terminal.
 */
function renderLiveDashboard() {
  const elapsedSec = ((Date.now() - suiteMetrics.startTime) / 1000) || 1;
  const currentRps = (suiteMetrics.totalSent / elapsedSec).toFixed(1);
  const currentRpm = (suiteMetrics.totalSent / (elapsedSec / 60)).toFixed(0);
  const avgLatency = suiteMetrics.successful > 0
    ? (suiteMetrics.totalLatencyMs / suiteMetrics.successful).toFixed(0)
    : 0;

  if (Number(currentRps) > suiteMetrics.peakRps) {
    suiteMetrics.peakRps = Number(currentRps);
  }

  const dashStr = `
${COLORS.bold(COLORS.cyan("--- LIVE LOAD DASHBOARD ---"))}
Elapsed: ${COLORS.bold(elapsedSec.toFixed(1) + "s")} | Current RPS: ${COLORS.bold(currentRps)} | Current RPM: ${COLORS.bold(currentRpm)}
Success: ${COLORS.green(suiteMetrics.successful)} | Failed: ${COLORS.red(suiteMetrics.failed)} | Avg Latency: ${COLORS.bold(avgLatency + "ms")}
Fastest: ${suiteMetrics.fastestLatency === Infinity ? 0 : suiteMetrics.fastestLatency}ms | Slowest: ${suiteMetrics.slowestLatency}ms | Cache Hits: ${COLORS.cyan(suiteMetrics.cacheHits)}
----------------------------`;

  console.log(COLORS.purple(dashStr));
}

// ----------------------------------------------------
// Test Mode Handlers
// ----------------------------------------------------

async function runSequentialTest() {
  console.log(COLORS.cyan(`\nStarting Sequential Test Mode (${CONFIG.TOTAL_REQUESTS} requests, 1 at a time)...\n`));
  for (let i = 1; i <= CONFIG.TOTAL_REQUESTS && !isStopping; i++) {
    await sendSingleRequest(i);
    if (CONFIG.DELAY > 0) await new Promise(r => setTimeout(r, CONFIG.DELAY));
  }
}

async function runConcurrentTest() {
  console.log(COLORS.cyan(`\nStarting Concurrent Test Mode (${CONFIG.TOTAL_REQUESTS} requests, Concurrency: ${CONFIG.CONCURRENT_USERS})...\n`));
  let currentId = 1;
  while (currentId <= CONFIG.TOTAL_REQUESTS && !isStopping) {
    const batch = [];
    for (let c = 0; c < CONFIG.CONCURRENT_USERS && currentId <= CONFIG.TOTAL_REQUESTS; c++) {
      batch.push(sendSingleRequest(currentId++));
    }
    await Promise.all(batch);
    if (CONFIG.DELAY > 0) await new Promise(r => setTimeout(r, CONFIG.DELAY));
  }
}

async function runBurstTest() {
  console.log(COLORS.cyan(`\nStarting Burst Test Mode (Firing ${CONFIG.TOTAL_REQUESTS} requests instantly)...\n`));
  const batch = [];
  for (let i = 1; i <= CONFIG.TOTAL_REQUESTS; i++) {
    batch.push(sendSingleRequest(i));
  }
  await Promise.all(batch);
}

async function runRampTest() {
  console.log(COLORS.cyan(`\nStarting Ramp Test Mode (Initial Concurrency: 1, Step: +${CONFIG.RAMP_STEP} every ${CONFIG.RAMP_INTERVAL}s)...\n`));
  let activeConcurrency = 1;
  let currentReqId = 1;
  let lastRampTime = Date.now();

  while (!isStopping && currentReqId <= CONFIG.TOTAL_REQUESTS) {
    if (Date.now() - lastRampTime >= CONFIG.RAMP_INTERVAL * 1000) {
      activeConcurrency += CONFIG.RAMP_STEP;
      lastRampTime = Date.now();
      console.log(COLORS.bold(COLORS.blue(`\n🚀 Ramping up concurrency to ${activeConcurrency} users!\n`)));
    }

    const batch = [];
    for (let i = 0; i < activeConcurrency && currentReqId <= CONFIG.TOTAL_REQUESTS; i++) {
      batch.push(sendSingleRequest(currentReqId++));
    }
    await Promise.all(batch);
    if (CONFIG.DELAY > 0) await new Promise(r => setTimeout(r, CONFIG.DELAY));
  }
}

async function runRpmTest() {
  console.log(COLORS.cyan(`\nStarting Requests Per Minute (RPM) Mode for ${CONFIG.TEST_DURATION_SECONDS} seconds...\n`));
  const endTime = Date.now() + (CONFIG.TEST_DURATION_SECONDS * 1000);
  let reqId = 1;

  while (Date.now() < endTime && !isStopping) {
    const batch = [];
    for (let c = 0; c < CONFIG.CONCURRENT_USERS && Date.now() < endTime && !isStopping; c++) {
      batch.push(sendSingleRequest(reqId++));
    }
    await Promise.all(batch);
    if (CONFIG.DELAY > 0) await new Promise(r => setTimeout(r, CONFIG.DELAY));
  }

  stopReason = `Duration Limit (${CONFIG.TEST_DURATION_SECONDS}s) Reached`;
}

// ----------------------------------------------------
// Master Runner & Final Report Generator
// ----------------------------------------------------

export async function startLoadTestSuite() {
  console.log(COLORS.bold(COLORS.purple("\n========================================================")));
  console.log(COLORS.bold(COLORS.purple("        Lumina AI Enterprise Load Testing Suite         ")));
  console.log(COLORS.bold(COLORS.purple("========================================================\n")));

  console.log(`Backend Target:    ${CONFIG.BACKEND_URL}`);
  console.log(`Route Endpoint:    ${CONFIG.ROUTE}`);
  console.log(`Test Mode:         ${CONFIG.TEST_MODE.toUpperCase()}`);
  console.log(`Config Total Req:  ${CONFIG.TOTAL_REQUESTS}`);
  console.log(`Concurrency Limit: ${CONFIG.CONCURRENT_USERS}`);
  console.log(`Duration Limit:    ${CONFIG.TEST_DURATION_SECONDS}s\n`);

  suiteMetrics.startTime = Date.now();
  dashboardIntervalId = setInterval(renderLiveDashboard, 3000);

  try {
    switch (CONFIG.TEST_MODE) {
      case "sequential":
        await runSequentialTest();
        break;
      case "burst":
        await runBurstTest();
        break;
      case "ramp":
        await runRampTest();
        break;
      case "rpm":
        await runRpmTest();
        break;
      case "concurrent":
      default:
        await runConcurrentTest();
        break;
    }
  } catch (err) {
    console.error(COLORS.red(`\nTest Execution Error: ${err.message}`));
    stopReason = `Execution Error: ${err.message}`;
  } finally {
    clearInterval(dashboardIntervalId);
    suiteMetrics.endTime = Date.now();
    finishAndReport();
  }
}

function finishAndReport() {
  const durationSec = Math.max(0.1, (suiteMetrics.endTime - suiteMetrics.startTime) / 1000);

  // Percentiles Calculation
  const successfulLatencies = requestLogs
    .filter(r => r.success)
    .map(r => r.duration)
    .sort((a, b) => a - b);

  const getPercentile = (p) => {
    if (successfulLatencies.length === 0) return 0;
    const idx = Math.floor(successfulLatencies.length * p);
    return successfulLatencies[Math.min(idx, successfulLatencies.length - 1)];
  };

  const p50 = getPercentile(0.50);
  const p95 = getPercentile(0.95);
  const p99 = getPercentile(0.99);

  const successRate = suiteMetrics.totalSent > 0 ? ((suiteMetrics.successful / suiteMetrics.totalSent) * 100).toFixed(2) : 0;
  const failureRate = suiteMetrics.totalSent > 0 ? ((suiteMetrics.failed / suiteMetrics.totalSent) * 100).toFixed(2) : 0;

  const avgRps = (suiteMetrics.successful / durationSec).toFixed(2);
  const avgRpm = (avgRps * 60).toFixed(0);
  const peakRpm = (suiteMetrics.peakRps * 60).toFixed(0);
  const estRph = (avgRpm * 60).toFixed(0);

  const cacheTotal = suiteMetrics.cacheHits + suiteMetrics.cacheMisses || 1;
  const cacheHitRate = ((suiteMetrics.cacheHits / cacheTotal) * 100).toFixed(1);
  const cacheMissRate = ((suiteMetrics.cacheMisses / cacheTotal) * 100).toFixed(1);

  // Provider Distribution & Breakdown
  const totalSuccessfulProviders = Object.values(suiteMetrics.providerStats).reduce((acc, curr) => acc + curr.successes, 0) || 1;

  const providerAnalysis = {};
  for (const [pName, pData] of Object.entries(suiteMetrics.providerStats)) {
    if (pName === "unknown" && pData.requests === 0) continue;
    const usagePct = ((pData.successes / totalSuccessfulProviders) * 100).toFixed(1);
    const avgLat = pData.successes > 0 ? (pData.totalLatency / pData.successes).toFixed(0) : 0;
    providerAnalysis[pName.toUpperCase()] = {
      requests: pData.requests,
      successes: pData.successes,
      failures: pData.failures,
      usagePercentage: `${usagePct}%`,
      avgLatencyMs: avgLat,
      fastestMs: pData.fastest === Infinity ? 0 : pData.fastest,
      slowestMs: pData.slowest
    };
  }

  const reportTxt = `
====================================
        AI Load Test Report
====================================
Stop Reason:                   ${stopReason}
Test Mode:                     ${CONFIG.TEST_MODE.toUpperCase()}
Duration:                      ${durationSec.toFixed(2)} seconds
Total Requests Sent:           ${suiteMetrics.totalSent}
Successful Requests:           ${suiteMetrics.successful}
Failed Requests:               ${suiteMetrics.failed}
Success Rate:                  ${successRate}%
Failure Rate:                  ${failureRate}%

Latency Statistics:
- Average Latency:             ${suiteMetrics.successful > 0 ? (suiteMetrics.totalLatencyMs / suiteMetrics.successful).toFixed(0) : 0} ms
- Median Latency (p50):        ${p50} ms
- 95th Percentile (p95):       ${p95} ms
- 99th Percentile (p99):       ${p99} ms
- Fastest Request:             ${suiteMetrics.fastestLatency === Infinity ? 0 : suiteMetrics.fastestLatency} ms
- Slowest Request:             ${suiteMetrics.slowestLatency} ms

Throughput & Capacity Projections:
- Maximum Concurrent Users:    ${CONFIG.CONCURRENT_USERS}
- Peak Requests Per Second:    ${suiteMetrics.peakRps} RPS
- Peak Requests Per Minute:    ${peakRpm} RPM
- Average Requests Per Second: ${avgRps} RPS
- Average Requests Per Minute: ${avgRpm} RPM
- Estimated Requests Per Hour: ${estRph} RPH

Cache Statistics:
- Cache Hit Rate:              ${cacheHitRate}% (${suiteMetrics.cacheHits})
- Cache Miss Rate:             ${cacheMissRate}% (${suiteMetrics.cacheMisses})

Provider Distribution & Performance:
${Object.entries(providerAnalysis).map(([name, data]) => `  • ${name}: ${data.usagePercentage} | Requests: ${data.requests} | Successes: ${data.successes} | Avg Latency: ${data.avgLatencyMs}ms`).join("\n")}

Failure Breakdown:
- 429 Rate Limits:             ${suiteMetrics.failureBreakdown.err429}
- 500 Server Errors:           ${suiteMetrics.failureBreakdown.err500}
- Request Timeouts:            ${suiteMetrics.failureBreakdown.timeout}
- Network Errors:              ${suiteMetrics.failureBreakdown.networkError}
- JSON Parsing Errors:         ${suiteMetrics.failureBreakdown.jsonError}
- Authentication Errors:       ${suiteMetrics.failureBreakdown.authError}
- Provider Exhausted Errors:   ${suiteMetrics.failureBreakdown.providerExhausted}
====================================
`;

  console.log(COLORS.bold(COLORS.purple(reportTxt)));

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const jsonPath = path.join(__dirname, "stress-report.json");
  const txtPath = path.join(__dirname, "stress-report.txt");

  const reportObj = {
    stopReason,
    config: CONFIG,
    summary: {
      durationSeconds: durationSec.toFixed(2),
      totalSent: suiteMetrics.totalSent,
      successful: suiteMetrics.successful,
      failed: suiteMetrics.failed,
      successRate: `${successRate}%`,
      failureRate: `${failureRate}%`,
      latenciesMs: {
        average: suiteMetrics.successful > 0 ? Number((suiteMetrics.totalLatencyMs / suiteMetrics.successful).toFixed(0)) : 0,
        medianP50: p50,
        p95: p95,
        p99: p99,
        fastest: suiteMetrics.fastestLatency === Infinity ? 0 : suiteMetrics.fastestLatency,
        slowest: suiteMetrics.slowestLatency
      },
      throughput: {
        maxConcurrentUsers: CONFIG.CONCURRENT_USERS,
        peakRps: suiteMetrics.peakRps,
        peakRpm: Number(peakRpm),
        averageRps: Number(avgRps),
        averageRpm: Number(avgRpm),
        estimatedRph: Number(estRph)
      },
      cache: {
        hitRate: `${cacheHitRate}%`,
        missRate: `${cacheMissRate}%`,
        hits: suiteMetrics.cacheHits,
        misses: suiteMetrics.cacheMisses
      },
      providerAnalysis,
      failureBreakdown: suiteMetrics.failureBreakdown
    },
    logs: requestLogs
  };

  fs.writeFileSync(jsonPath, JSON.stringify(reportObj, null, 2));
  fs.writeFileSync(txtPath, reportTxt.trim());

  console.log(COLORS.bold(COLORS.green(`\nAI Load Test Suite completed. Reports generated:`)));
  console.log(COLORS.cyan(`- JSON: ${jsonPath}`));
  console.log(COLORS.cyan(`- TXT:  ${txtPath}\n`));
}

// Auto-run if executed directly from node CLI
if (process.argv[1] && process.argv[1].includes("stressTest.js")) {
  startLoadTestSuite();
}