import { createRequestStore, verifyStoreKey, json } from "../../lib/store.mjs";

const MAX_TEXT_CHARACTERS = 1200;
const MAX_REQUEST_CHARACTERS = 12_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const DEFAULT_HD_VOICE = "fil-PH-Blessica:DragonHDLatestNeural";

function incidentId() {
  return `azure-speech-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getSpeechConfig() {
  const key = process.env.AZURE_SPEECH_KEY?.trim() || "";
  const region = process.env.AZURE_SPEECH_REGION?.trim().toLowerCase() || "";
  if (!key || !/^[a-z0-9]+$/.test(region)) return null;
  return { key, region };
}

async function requestSpeech({ key, region, text, language, voiceName, signal }) {
  const endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const locale = language === "en-PH" ? "en-PH" : "fil-PH";
  const safeText = escapeXml(text);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceName}"><prosody rate="+5%" pitch="+1st"><lang xml:lang="${locale}">${safeText}</lang></prosody></voice></speak>`;

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "39ers-Delights-POS",
    },
    body: ssml,
    signal,
  });
}

export default async function handler(request) {
  if (request.method === "GET") {
    const configured = Boolean(getSpeechConfig());
    return json({
      ok: true,
      provider: "Azure AI Speech",
      configured,
      defaultVoice: DEFAULT_HD_VOICE,
      language: "Filipino and English (Philippines)",
    });
  }

  if (request.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed." }, 405, { Allow: "GET, POST" });
  }

  let store;
  try {
    // Create the Blobs client inside this request, where Netlify provides its site credentials.
    store = createRequestStore();
    if (!(await verifyStoreKey(request, store))) {
      return json({ ok: false, code: "POS_DEVICE_NOT_AUTHORIZED", message: "This cashier device is not authorized to use the voice service." }, 403);
    }
  } catch (error) {
    const id = incidentId();
    console.error(`[azure-voice] ${id} cashier authorization check failed`, error?.name || "Error");
    return json({
      ok: false,
      code: "VOICE_AUTH_STORAGE_UNAVAILABLE",
      message: "Cashier voice authorization is temporarily unavailable. The built-in browser voice will be used instead.",
      incidentId: id,
    }, 503, { "Retry-After": "3" });
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_REQUEST_CHARACTERS) {
      return json({ ok: false, code: "REQUEST_TOO_LARGE", message: "Voice request is too large." }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, code: "INVALID_JSON", message: "Invalid voice request." }, 400);
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const language = ["fil-PH", "en-PH", "fil-en-PH"].includes(body?.language) ? body.language : "fil-PH";
  if (!text || text.length > MAX_TEXT_CHARACTERS) {
    return json({
      ok: false,
      code: "INVALID_VOICE_TEXT",
      message: `Voice text must contain between 1 and ${MAX_TEXT_CHARACTERS} characters.`,
    }, 400);
  }

  const speechConfig = getSpeechConfig();
  if (!speechConfig) {
    return json({
      ok: false,
      code: "AZURE_SPEECH_NOT_CONFIGURED",
      message: "Azure Speech is not configured. Add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in Netlify Environment variables, then redeploy.",
    }, 503, { "Retry-After": "60" });
  }

  const effectiveLanguage = language === "en-PH" ? "en-PH" : "fil-PH";
  const fallbackVoice = effectiveLanguage === "en-PH" ? "en-PH-RosaNeural" : "fil-PH-BlessicaNeural";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const id = incidentId();

  try {
    let upstream = await requestSpeech({
      ...speechConfig,
      text,
      language: effectiveLanguage,
      voiceName: DEFAULT_HD_VOICE,
      signal: controller.signal,
    });

    // If the multilingual HD voice is temporarily unavailable for this resource,
    // fall back to the standard female Filipino/Philippine-English neural voice.
    if (!upstream.ok && [400, 404, 422].includes(upstream.status)) {
      upstream = await requestSpeech({
        ...speechConfig,
        text,
        language: effectiveLanguage,
        voiceName: fallbackVoice,
        signal: controller.signal,
      });
    }

    if (!upstream.ok) {
      console.error(`[azure-voice] ${id} Speech provider returned HTTP ${upstream.status}`);
      return json({
        ok: false,
        code: "AZURE_SPEECH_PROVIDER_ERROR",
        message: "Azure Speech could not generate this announcement. The POS will use its built-in browser voice instead.",
        incidentId: id,
        providerStatus: upstream.status,
      }, 502, { "Retry-After": "2" });
    }

    const audio = await upstream.arrayBuffer();
    if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
      console.error(`[azure-voice] ${id} provider returned an empty or oversized audio response`);
      return json({
        ok: false,
        code: "INVALID_AZURE_AUDIO",
        message: "Azure Speech returned an invalid audio response. The POS will use its built-in browser voice instead.",
        incidentId: id,
      }, 502);
    }

    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Voice-Provider": "Azure-Speech",
      },
    });
  } catch (error) {
    console.error(`[azure-voice] ${id} synthesis request failed`, error?.name || "Error");
    return json({
      ok: false,
      code: error?.name === "AbortError" ? "AZURE_SPEECH_TIMEOUT" : "AZURE_SPEECH_REQUEST_FAILED",
      message: "Azure Speech is temporarily unavailable. The POS will use its built-in browser voice instead.",
      incidentId: id,
    }, 502, { "Retry-After": "2" });
  } finally {
    clearTimeout(timeout);
  }
}

export const config = { path: "/api/azure-voice", method: ["GET", "POST"] };
