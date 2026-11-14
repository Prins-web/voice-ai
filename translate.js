const ALLOWED_VOICES = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_LENGTH = 4000;

async function readRequestBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Audio is too large for this Vercel serverless endpoint. Use a smaller/shorter audio file, or deploy a storage-backed processing service for large media.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to submit an audio file." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return response.status(503).json({ error: "Translation is not configured. Add OPENAI_API_KEY to your Vercel environment variables." });
  }
  const language = typeof request.query.language === "string" ? request.query.language.trim() : "";
  const voice = typeof request.query.voice === "string" && ALLOWED_VOICES.has(request.query.voice) ? request.query.voice : "alloy";
  if (!language || language.length > 50) {
    return response.status(400).json({ error: "Choose a valid target language." });
  }

  let audioBytes;
  try {
    audioBytes = await readRequestBody(request, MAX_FILE_BYTES);
  } catch (error) {
    if (error.statusCode === 413) return response.status(413).json({ error: error.message });
    console.error("Could not read uploaded audio:", error);
    return response.status(400).json({ error: "Could not read the uploaded audio." });
  }
  if (!audioBytes.length) return response.status(400).json({ error: "The uploaded audio file is empty." });

  const mimeType = typeof request.headers["content-type"] === "string"
    ? request.headers["content-type"].split(";")[0]
    : "application/octet-stream";
  const extension = mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: mimeType }), `audio.${extension}`);
  form.append("model", "whisper-1");

  try {
    const transcriptionResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!transcriptionResponse.ok) {
      const body = await transcriptionResponse.text();
      console.error("OpenAI transcription error:", transcriptionResponse.status, body.slice(0, 1000));
      return response.status(502).json({ error: "Speech recognition failed. Check the audio format and your OpenAI API account." });
    }
    const transcription = await transcriptionResponse.json();
    const sourceText = typeof transcription.text === "string" ? transcription.text.trim() : "";
    if (!sourceText) return response.status(422).json({ error: "No speech was detected in this audio." });
    if (sourceText.length > MAX_TRANSCRIPT_LENGTH) {
      return response.status(413).json({ error: "This audio has too much speech for one translation request. Choose a shorter section." });
    }

    const translationResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Translate the following spoken transcript into ${language}. Preserve its meaning, tone, names, and formatting. Return only the translated text, without commentary.` },
          { role: "user", content: sourceText },
        ],
        temperature: 0.2,
      }),
    });
    if (!translationResponse.ok) {
      const body = await translationResponse.text();
      console.error("OpenAI translation error:", translationResponse.status, body.slice(0, 1000));
      return response.status(502).json({ error: "Text translation failed. Check your OpenAI API account and try again." });
    }
    const translatedText = (await translationResponse.json()).choices?.[0]?.message?.content?.trim();
    if (!translatedText) return response.status(502).json({ error: "The translation service returned an empty transcript." });
    if (translatedText.length > 4096) {
      return response.status(413).json({ error: "The translated speech is too long for one voiceover. Choose a shorter audio section." });
    }

    const speechResponse = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: translatedText,
        response_format: "mp3",
      }),
    });
    if (!speechResponse.ok) {
      const body = await speechResponse.text();
      console.error("OpenAI speech generation error:", speechResponse.status, body.slice(0, 1000));
      return response.status(502).json({ error: "Voice generation failed. Try a shorter audio section or check your OpenAI API account." });
    }
    const speech = Buffer.from(await speechResponse.arrayBuffer());
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Content-Length", String(speech.length));
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Translated-Text", encodeURIComponent(translatedText.slice(0, 2000)));
    return response.status(200).send(speech);
  } catch (error) {
    console.error("Unexpected translation error:", error);
    return response.status(502).json({ error: "Audio translation could not be completed. Please try again." });
  }
};
