import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.24.1";

export const GEMINI_API_VERSION = "v1";
export const GEMINI_MODEL_CANDIDATES = ["gemini-1.5-flash", "gemini-1.5-flash-001", "gemini-1.5-flash-002", "gemini-1.5-flash-latest"];
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1/models";

export function extractGeminiError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown Gemini error";
}

export async function listStableGeminiModels(apiKey: string) {
  const response = await fetch(GEMINI_MODELS_URL, { headers: { "x-goog-api-key": apiKey.trim() } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? `Gemini model list failed with HTTP ${response.status}`);
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .filter((model) => Array.isArray(model?.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent"))
    .map((model) => String(model?.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}

export async function generateGeminiText(apiKey: string, prompt: string, maxOutputTokens = 300) {
  const genAI = new GoogleGenerativeAI(apiKey.trim());
  const failures: string[] = [];
  const stableModels = await listStableGeminiModels(apiKey).catch(() => []);
  const discoveredFlashModels = stableModels.filter((modelName) => modelName.startsWith("gemini-1.5-flash"));
  const candidateModels = [...new Set([...GEMINI_MODEL_CANDIDATES, ...discoveredFlashModels])];

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel(
        { model: modelName, generationConfig: { temperature: 0.2, maxOutputTokens } },
        { apiVersion: GEMINI_API_VERSION },
      );
      const result = await model.generateContent(prompt);
      return { text: result.response.text().trim(), modelName };
    } catch (error) {
      failures.push(`${modelName}: ${extractGeminiError(error)}`);
    }
  }

  const available = stableModels.length ? ` Available stable models: ${stableModels.slice(0, 12).join(", ")}.` : "";
  throw new Error(`${failures.at(-1) ?? "Gemini 1.5 Flash did not return a response."}${available}`);
}