export const OPENAI_MODEL = "gpt-4o";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export async function generateOpenAIText(apiKey: string, prompt: string, maxOutputTokens = 300) {
  const response = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "You are a disciplined institutional Nifty options risk engine. Return concise, structured trading signals only." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: maxOutputTokens,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `OpenAI GPT-4o request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI GPT-4o did not return a response.");
  return { text: String(text).trim(), modelName: OPENAI_MODEL };
}