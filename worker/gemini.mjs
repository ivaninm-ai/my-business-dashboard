// The API key is used only by the Actions worker, never by the static page.
export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export function providerError(error) {
  const status = error?.status;
  if (status === 401 || status === 400 && error.keyError) return 'Gemini rejected the API key. Check GEMINI_API_KEY in GitHub Secrets.';
  if (status === 403) return 'Gemini access denied. Check the key, project permissions and regional availability.';
  if (status === 429) return 'Gemini quota reached. Data remains available. Wait for quota to reset, then retry.';
  if (status === 404) return 'Gemini model unavailable for this project. Check AI_MODEL against Google AI Studio.';
  if (status) return `Gemini request failed (${status}). Retry later; your saved data has not changed.`;
  return String(error?.message || 'Could not reach Gemini. Retry later.').slice(0, 300);
}

export async function generateJson({ apiKey, model = DEFAULT_MODEL, system, prompt, schema, fetchFn = fetch, clientFactory }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY secret is not set in this repository.');
  if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('AI_MODEL is not a valid Gemini model name.');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', ...(schema ? { responseJsonSchema: schema } : {}), maxOutputTokens: 24000 },
  };
  let response;
  if (clientFactory) response = await clientFactory().generateContent({ model, ...body });
  else {
    const res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const error = new Error('Gemini request failed'); error.status = res.status;
      error.keyError = detail.error?.details?.some(d => d.reason === 'API_KEY_INVALID');
      throw error;
    }
    response = await res.json();
  }
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason !== 'STOP') throw new Error('Gemini could not produce a complete result. Retry, or use a smaller document.');
  let parsed;
  try { parsed = JSON.parse(candidate.content.parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('')); }
  catch { throw new Error('Gemini returned an unreadable result. Retry; nothing has been activated.'); }
  return { parsed, model: response.modelVersion || model, usage: { input_tokens: response.usageMetadata?.promptTokenCount, output_tokens: response.usageMetadata?.candidatesTokenCount } };
}
