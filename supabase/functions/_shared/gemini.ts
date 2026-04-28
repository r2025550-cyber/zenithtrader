import { GoogleGenerativeAI } from "npm:@google/generative-ai@0.24.1";

export const GEMINI_API_VERSION = "v1";
export const GEMINI_MODEL_CANDIDATES = ["gemini-1.5-flash-002", "gemini-1.5-flash", "gemini-1.5-flash-latest"];

export function extractGeminiError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown Gemini error";
}

export async function generateGeminiText(apiKey: string, prompt: string, maxOutputTokens = 300) {
  const genAI = new GoogleGenerativeAI(apiKey.trim());
  const failures: string[] = [];

  for (const modelName of GEMINI_MODEL_CANDIDATES) {
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

  throw new Error(failures.at(-1) ?? "Gemini 1.5 Flash did not return a response.");
}