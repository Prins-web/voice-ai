const VOICES = new Set(["hannah", "troy", "austin", "autumn", "diana", "daniel", "fahad", "lulwa", "noura", "abdullah", "sultan", "aisha"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_LENGTH = 4000;
const TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const TRANSLATION_MODEL = "llama-3.1-8b-instant";
const TRANSLATION_MODEL_FALLBACK = "llama-3.3-70b-versatile";

async function readRequestBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Audio is too large for this Vercel serverless endpoint. Use a shorter section, or deploy storage-backed processing for longer media.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function translateText(apiKey, sourceText, language) {
  const body = (model) => JSON.stringify({
    model,
    messages: [
      { role: "system", content: `Translate the following spoken transcript into ${language}. Preserve its meaning, tone, names, and formatting. Return only the translated text, without commentary.` },
      { role: "user", content: sourceText },
    ],
    temperature: 0.2,
    max_tokens: 2048,
  });
  const request = (model) => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body(model),
  });

  let response = await request(TRANSLATION_MODEL);
  if (!response.ok && response.status >= 500) {
    const bodyText = await response.text();
    console.error("Groq translation error (primary):", response.status, bodyText.slice(0, 1000));
    response = await request(TRANSLATION_MODEL_FALLBACK);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    console.error("Groq translation error:", response.status, bodyText.slice(0, 1000));
    return { error: "Text translation failed. Check your Groq API account and try again." };
  }
  const translatedText = (await response.json()).choices?.[0]?.message?.content?.trim();
  if (!translatedText) return { error: "The translation service returned an empty transcript." };
  return { translatedText };
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to submit an audio file." });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return response.status(503).json({ error: "Translation is not configured. Add GROQ_API_KEY to your Vercel environment variables." });

  const language = typeof request.query.language === "string" ? request.query.language.trim() : "";
  const requestedVoice = typeof request.query.voice === "string" ? request.query.voice : "";
  const voice = VOICES.has(requestedVoice) ? requestedVoice : "hannah";
  if (!language || language.length > 50) return response.status(400).json({ error: "Enter a valid target language." });

  let audioBytes;
  try {
    audioBytes = await readRequestBody(request, MAX_FILE_BYTES);
  } catch (error) {
    if (error.statusCode === 413) return response.status(413).json({ error: error.message });
    console.error("Could not read uploaded audio:", error);
    return response.status(400).json({ error: "Could not read the uploaded audio." });
  }
  if (!audioBytes.length) return response.status(400).json({ error: "The uploaded audio file is empty." });

  const timings = {};
  const mimeType = typeof request.headers["content-type"] === "string"
    ? request.headers["content-type"].split(";")[0]
    : "application/octet-stream";
  const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: mimeType }), `audio.${extension}`);
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");

  try {
    const startedAt = Date.now();
    const transcriptionResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    timings.transcribe = Date.now() - startedAt;
    if (!transcriptionResponse.ok) {
      const body = await transcriptionResponse.text();
      console.error("Groq transcription error:", transcriptionResponse.status, body.slice(0, 1000));
      return response.status(502).json({ error: "Speech recognition failed. Check the audio format and your Groq API account." });
    }
    const transcription = await transcriptionResponse.json();
    const sourceText = typeof transcription.text === "string" ? transcription.text.trim() : "";
    if (!sourceText) return response.status(422).json({ error: "No speech was detected in this audio." });
    if (sourceText.length > MAX_TRANSCRIPT_LENGTH) {
      return response.status(413).json({ error: "This audio has too much speech for one translation request. Choose a shorter section." });
    }

    const translateStartedAt = Date.now();
    const translated = await translateText(apiKey, sourceText, language);
    timings.translate = Date.now() - translateStartedAt;
    if (translated.error) return response.status(502).json({ error: translated.error });
    const translatedText = translated.translatedText;
    if (translatedText.length > 4000) {
      return response.status(413).json({ error: "The translated speech is too long for one voiceover. Choose a shorter audio section." });
    }

    const languageKey = language.toLowerCase();
    const ttsModel = languageKey === "english" || languageKey === "en"
      ? "canopylabs/orpheus-v1-english"
      : languageKey === "arabic" || languageKey === "ar"
        ? "canopylabs/orpheus-arabic-saudi"
        : null;
    let audioBase64 = null;
    let audioMimeType = null;
    let audioUnavailableReason = "Groq speech generation currently supports English and Saudi Arabic. Your translated transcript is ready to copy or download.";
    if (ttsModel && translatedText.length <= 200) {
      const arabic = ttsModel === "canopylabs/orpheus-arabic-saudi";
      const selectedVoice = arabic
        ? ["fahad", "lulwa", "noura", "abdullah", "sultan", "aisha"].includes(voice) ? voice : "fahad"
        : ["hannah", "troy", "austin", "autumn", "diana", "daniel"].includes(voice) ? voice : "hannah";
      const speechStartedAt = Date.now();
      const speechResponse = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ttsModel,
          voice: selectedVoice,
          input: translatedText,
          response_format: "wav",
        }),
      });
      timings.speech = Date.now() - speechStartedAt;
      if (!speechResponse.ok) {
        const body = await speechResponse.text();
        console.error("Groq speech generation error:", speechResponse.status, body.slice(0, 1000));
        return response.status(502).json({ error: "Voice generation failed. Your language translation succeeded; try again or download the transcript." });
      }
      audioBase64 = Buffer.from(await speechResponse.arrayBuffer()).toString("base64");
      audioMimeType = "audio/wav";
      audioUnavailableReason = null;
    } else if (ttsModel) {
      audioUnavailableReason = "Groq speech generation accepts up to 200 characters at a time. Your translated transcript is ready to download.";
    }

    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ translatedText, audioBase64, audioMimeType, audioUnavailableReason, timings });
  } catch (error) {
    console.error("Unexpected translation error:", error);
    return response.status(502).json({ error: "Audio translation could not be completed. Please try again." });
  }
};
