import { createRequestStore, verifyStoreKey, json } from "../../lib/store.mjs";

const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const MAX_TEXT_CHARACTERS = 1200;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function incidentId() {
  return `elevenlabs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default async function handler(request) {
  if (request.method === "GET") {
    const configured = Boolean(
      process.env.ELEVENLABS_API_KEY?.trim() &&
      process.env.ELEVENLABS_VOICE_ID?.trim()
    );
    return json({
      ok: true,
      configured,
      provider: "ElevenLabs",
      model: process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    }, 200);
  }

  if (request.method !== "POST") {
    return json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed." }, 405, { Allow: "GET, POST" });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || "";
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || "";
  if (!apiKey || !voiceId) {
    return json({
      ok: false,
      code: "ELEVENLABS_NOT_CONFIGURED",
      message: "ElevenLabs voice is not configured. Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in Netlify environment variables, then redeploy.",
    }, 503, { "Retry-After": "60" });
  }

  // Only the registered cashier POS browser may spend ElevenLabs credits.
  // Create the Blobs client inside the request so Netlify's site credentials are available.
  let store;
  try {
    store = createRequestStore();
    if (!(await verifyStoreKey(request, store))) {
      return json({ ok: false, code: "POS_DEVICE_NOT_AUTHORIZED", message: "This POS device is not authorized to use the voice service." }, 403);
    }
  } catch (error) {
    const id = incidentId();
    console.error(`[elevenlabs-voice] ${id} cashier authorization check failed`, error?.name || "Error");
    return json({ ok: false, code: "VOICE_AUTH_STORAGE_UNAVAILABLE", message: "POS voice authorization is temporarily unavailable. The browser voice will be used instead.", incidentId: id }, 503, { "Retry-After": "3" });
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 12_000) {
      return json({ ok: false, code: "REQUEST_TOO_LARGE", message: "Voice announcement is too long." }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, code: "INVALID_JSON", message: "Invalid voice request." }, 400);
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT_CHARACTERS) {
    return json({
      ok: false,
      code: "INVALID_VOICE_TEXT",
      message: `Voice text must contain between 1 and ${MAX_TEXT_CHARACTERS} characters.`,
    }, 400);
  }

  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const id = incidentId();

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        // Designed for a warm, energetic, friendly female voice selected in the
        // ElevenLabs Voice Library. Filipino and English are both supported by Flash v2.5.
        voice_settings: {
          stability: 0.42,
          similarity_boost: 0.78,
          style: 0.55,
          use_speaker_boost: true,
        },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      console.error(`[elevenlabs-voice] ${id} provider returned HTTP ${upstream.status}`);
      return json({
        ok: false,
        code: "ELEVENLABS_PROVIDER_ERROR",
        message: "ElevenLabs could not generate the voice announcement. The POS will use its built-in browser voice instead.",
        incidentId: id,
        providerStatus: upstream.status,
      }, 502, { "Retry-After": "2" });
    }

    const audio = await upstream.arrayBuffer();
    if (!audio.byteLength || audio.byteLength > MAX_AUDIO_BYTES) {
      console.error(`[elevenlabs-voice] ${id} provider returned an empty or oversized audio response`);
      return json({
        ok: false,
        code: "INVALID_ELEVENLABS_AUDIO",
        message: "ElevenLabs returned an invalid audio response. The POS will use its built-in browser voice instead.",
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
      },
    });
  } catch (error) {
    console.error(`[elevenlabs-voice] ${id} request failed`, error?.name || "Error");
    return json({
      ok: false,
      code: error?.name === "AbortError" ? "ELEVENLABS_TIMEOUT" : "ELEVENLABS_REQUEST_FAILED",
      message: "ElevenLabs is temporarily unavailable. The POS will use its built-in browser voice instead.",
      incidentId: id,
    }, 502, { "Retry-After": "2" });
  } finally {
    clearTimeout(timeout);
  }
}

export const config = { path: "/api/elevenlabs-voice", method: ["GET", "POST"] };
