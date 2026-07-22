const PROVIDERS = [
  "gemini",
  "groq",
  "openrouter",
  "openai"
];

const providerHealth = {};

for (const provider of PROVIDERS) {
  providerHealth[provider] = {
    name: provider,
    healthy: true,
    cooldownUntil: 0,

    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,

    timeoutCount: 0,
    quotaErrors: 0,

    averageResponseTime: 0,
    fastestResponse: Infinity,
    slowestResponse: 0,

    activeRequests: 0,

    lastFailure: null
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
  const pKey = String(provider).toLowerCase();
  const health = providerHealth[pKey];

  if (!health) return true;

  if (health.cooldownUntil > 0) {
    if (Date.now() < health.cooldownUntil) {
      return false; // Currently in cooldown
    } else {
      // Cooldown expired! Perform automatic recovery
      health.cooldownUntil = 0;
      health.healthy = true;
    }
  }

  return health.healthy;
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
  health.cooldownUntil = 0;

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
  health.lastFailure = new Date();

  const message = String(error).toLowerCase();

  if (
    message.includes("429") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("service unavailable") ||
    message.includes("503") ||
    message.includes("exceeded")
  ) {
    health.quotaErrors++;
    health.healthy = false;
    health.cooldownUntil = Date.now() + (15 * 60 * 1000); // 15-minute cooldown
  }

  if (message.includes("timeout")) {
    health.timeoutCount++;
  }
}

export function resetProvider(provider) {
  const pKey = String(provider).toLowerCase();
  if (!providerHealth[pKey]) return;

  providerHealth[pKey].healthy = true;
  providerHealth[pKey].cooldownUntil = 0;
}

export default providerHealth;