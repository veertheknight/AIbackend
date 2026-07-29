const PROVIDERS = ["gemini", "openai", "openrouter", "groq"];

const providerHealth = {};

for (const provider of PROVIDERS) {
  providerHealth[provider] = {
    name: provider,
    healthy: true,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    timeoutCount: 0,
    quotaErrors: 0,
    averageResponseTime: 0,
    fastestResponse: Infinity,
    slowestResponse: 0,
    activeRequests: 0,
    lastFailure: null,
    lastSuccessTime: null,
  };
}

export function getProviderHealth(provider) {
  const pKey = String(provider).toLowerCase();
  return providerHealth[pKey];
}

export function getAllProviderHealth() {
  return providerHealth;
}

export function isProviderHealthy(provider) {
  // Always return true for fresh request evaluations - never block requests globally!
  const pKey = String(provider).toLowerCase();
  const health = providerHealth[pKey];
  return health ? health.healthy : true;
}

export function startRequest(provider) {
  const pKey = String(provider).toLowerCase();
  const health = providerHealth[pKey];
  if (!health) return;
  health.totalRequests++;
  health.activeRequests++;
}

export function finishSuccess(provider, responseTime) {
  const pKey = String(provider).toLowerCase();
  const health = providerHealth[pKey];
  if (!health) return;

  if (health.activeRequests > 0) {
    health.activeRequests--;
  }

  health.successfulRequests++;
  health.healthy = true;
  health.lastSuccessTime = new Date().toISOString();

  if (responseTime < health.fastestResponse) {
    health.fastestResponse = responseTime;
  }

  if (responseTime > health.slowestResponse) {
    health.slowestResponse = responseTime;
  }

  const total = health.successfulRequests;
  health.averageResponseTime =
    ((health.averageResponseTime * (total - 1)) + responseTime) / total;
}

export function finishFailure(provider, error = "") {
  const pKey = String(provider).toLowerCase();
  const health = providerHealth[pKey];
  if (!health) return;

  if (health.activeRequests > 0) {
    health.activeRequests--;
  }

  health.failedRequests++;
  health.lastFailure = {
    time: new Date().toISOString(),
    reason: String(error),
  };

  const errStr = String(error).toLowerCase();
  if (errStr.includes("timeout") || errStr.includes("abort")) {
    health.timeoutCount++;
  }
  if (errStr.includes("429") || errStr.includes("quota") || errStr.includes("rate limit")) {
    health.quotaErrors++;
  }
}

export default {
  getProviderHealth,
  getAllProviderHealth,
  isProviderHealthy,
  startRequest,
  finishSuccess,
  finishFailure,
};