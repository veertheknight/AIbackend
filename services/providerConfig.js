export const providerConfig = {
  "Homework Solver": ["gemini", "openai", "openrouter", "groq"],
  "Homework": ["gemini", "openai", "openrouter", "groq"],

  "PDF Summary": ["gemini", "openai", "openrouter", "groq"],
  "PDF": ["gemini", "openai", "openrouter", "groq"],

  "Translator": ["gemini", "openai", "groq", "openrouter"],

  "WhatsApp Reply": ["gemini", "openai", "groq", "openrouter"],
  "WhatsApp": ["gemini", "openai", "groq", "openrouter"],

  "Email Writer": ["gemini", "openai", "groq", "openrouter"],
  "Email": ["gemini", "openai", "groq", "openrouter"],

  "Resume Builder": ["gemini", "openai", "groq", "openrouter"],
  "Resume": ["gemini", "openai", "groq", "openrouter"],

  "Scam Detector": ["gemini", "openai", "groq", "openrouter"],
  "Scam": ["gemini", "openai", "groq", "openrouter"],

  "Fake News Detector": ["gemini", "openai", "groq", "openrouter"],
  "Fake News": ["gemini", "openai", "groq", "openrouter"],

  "Image Analyzer": ["gemini", "openai", "groq", "openrouter"],

  "Voice Assistant": ["gemini", "openai", "groq", "openrouter"],
  "Voice Chat": ["gemini", "openai", "groq", "openrouter"],

  "Code Generator": ["gemini", "openai", "groq", "openrouter"],
  "Code Assistant": ["gemini", "openai", "groq", "openrouter"],
  "Code": ["gemini", "openai", "groq", "openrouter"],

  "default": ["gemini", "openai", "openrouter", "groq"]
};

export const providerTimeouts = {
  gemini: 25000,    // 25 seconds
  openai: 25000,    // 25 seconds
  openrouter: 25000,// 25 seconds
  groq: 25000       // 25 seconds
};

export function getToolProviderPriority(toolName) {
  if (!toolName) return providerConfig["default"];
  return providerConfig[toolName] || providerConfig["default"];
}

export function getProviderTimeout(providerName) {
  const key = String(providerName).toLowerCase();
  return providerTimeouts[key] || 25000;
}

export default providerConfig;