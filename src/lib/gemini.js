// Thin client for the Gemini REST API, called straight from the browser.
// The user's API key goes only to generativelanguage.googleapis.com.

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

function friendlyError(status, message = '') {
  if (status === 400 && /api key/i.test(message)) return 'Your Gemini API key is not valid. Check it in Settings.';
  if (status === 403) return `Gemini refused the request (403). ${message}`.trim();
  if (status === 404) return `Model not found (404). Pick another model in Settings. ${message}`.trim();
  if (status === 429) return 'Gemini rate limit or quota reached (429). Wait a moment and try again.';
  return message || `Gemini request failed (HTTP ${status}).`;
}

async function request(path, { apiKey, body, signal }) {
  if (!apiKey) throw new GeminiError('Add your Gemini API key in Settings first.', 401);
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }
        : { 'x-goog-api-key': apiKey },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (res.ok) return res;

    const retryable = res.status === 429 || res.status === 500 || res.status === 503;
    if (retryable && attempt < maxAttempts) {
      await sleep(1500 * 2 ** (attempt - 1), signal);
      continue;
    }
    let message = '';
    try {
      message = (await res.json())?.error?.message || '';
    } catch {
      /* ignore */
    }
    throw new GeminiError(friendlyError(res.status, message), res.status);
  }
}

function buildBody({ system, contents, tools, toolConfig, generationConfig }) {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = tools;
  if (toolConfig) body.toolConfig = toolConfig;
  if (generationConfig) body.generationConfig = generationConfig;
  return body;
}

function readCandidate(json) {
  const cand = json?.candidates?.[0];
  return {
    parts: cand?.content?.parts ?? [],
    finishReason: cand?.finishReason,
    groundingMetadata: cand?.groundingMetadata,
    blockReason: json?.promptFeedback?.blockReason,
    usage: json?.usageMetadata,
  };
}

/** Visible text of a response (skips thought summaries). */
export const textOf = (parts) =>
  parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');

/** Non-streaming generateContent. Returns { parts, groundingMetadata, ... }. */
export async function generate({ apiKey, model, signal, ...rest }) {
  const res = await request(`models/${encodeURIComponent(model)}:generateContent`, {
    apiKey,
    signal,
    body: buildBody(rest),
  });
  return readCandidate(await res.json());
}

/**
 * Streaming generateContent (SSE). Calls onText(delta) for visible text as it
 * arrives. Parts are kept exactly as received (including thoughtSignature
 * fields), because Gemini 3+ requires them to be sent back on tool turns.
 */
export async function generateStream({ apiKey, model, signal, onText, ...rest }) {
  const res = await request(`models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    apiKey,
    signal,
    body: buildBody(rest),
  });

  const out = { parts: [], finishReason: undefined, groundingMetadata: undefined, blockReason: undefined };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.error) throw new GeminiError(json.error.message || 'Gemini stream error', json.error.code);
    const c = readCandidate(json);
    for (const part of c.parts) {
      out.parts.push(part);
      if (typeof part.text === 'string' && !part.thought && part.text) onText?.(part.text);
    }
    out.finishReason = c.finishReason ?? out.finishReason;
    out.groundingMetadata = c.groundingMetadata ?? out.groundingMetadata;
    out.blockReason = c.blockReason ?? out.blockReason;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(handleLine);
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);
  return out;
}

/** Lists Gemini models that support generateContent, newest-looking first. */
export async function listModels(apiKey, signal) {
  const res = await request('models?pageSize=1000', { apiKey, signal });
  const json = await res.json();
  return (json.models ?? [])
    .filter(
      (m) =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        /gemini/i.test(m.name) &&
        !/(embedding|image|tts|audio|live|native|robotics|computer-use)/i.test(m.name),
    )
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

/** Extracts web sources from Google Search grounding metadata. */
export function groundingSources(meta) {
  const seen = new Set();
  return (meta?.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w) => w?.uri && !seen.has(w.uri) && seen.add(w.uri))
    .map((w) => ({ title: w.title || new URL(w.uri).hostname, url: w.uri }));
}
