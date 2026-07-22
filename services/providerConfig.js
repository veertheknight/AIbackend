export const providerConfig = {
  "Homework Solver": ["gemini", "groq", "openrouter", "openai"],

  "Image Generator": ["gemini", "openai", "openrouter"],

  "Image Analyzer": ["gemini", "openai", "groq", "openrouter"],

  "PDF Summary": ["openrouter", "gemini", "groq", "openai"],

  "Translator": ["groq", "openai", "gemini", "openrouter"],

  "WhatsApp Reply": ["groq", "openai", "gemini", "openrouter"],

  "Email Writer": ["groq", "openai", "gemini", "openrouter"],

  "Resume Builder": ["openai", "groq", "gemini", "openrouter"],
  "Resume": ["openai", "groq", "gemini", "openrouter"],

  "Code Generator": ["openai", "groq", "gemini", "openrouter"],
  "Code Assistant": ["openai", "groq", "gemini", "openrouter"],
  "Code": ["openai", "groq", "gemini", "openrouter"],

  "Voice Assistant": ["openai", "groq", "gemini", "openrouter"],
  "Voice Chat": ["openai", "groq", "gemini", "openrouter"],

  "Scam Detector": ["groq", "gemini", "openai", "openrouter"],

  "Fake News Detector": ["groq", "gemini", "openai", "openrouter"]
};

export const providerTimeouts = {
  gemini: 12000,    // 12 seconds
  groq: 10000,      // 10 seconds
  openai: 15000,    // 15 seconds
  openrouter: 12000 // 12 seconds
};

export function getToolProviderPriority(toolName) {
  if (!toolName) return ["gemini", "groq", "openrouter", "openai"];
  return providerConfig[toolName] || providerConfig["Homework Solver"];
}

export function getProviderTimeout(providerName) {
  const key = String(providerName).toLowerCase();
  return providerTimeouts[key] || 15000;
}

export default providerConfig;