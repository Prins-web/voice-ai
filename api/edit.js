const MAX_REQUEST_BYTES = 8 * 1024;
const ASPECT_RATIOS = new Set(["16:9", "9:16", "1:1"]);

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("The edit instruction is too long.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to request an AI edit." });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return response.status(503).json({ error: "AI editing is not configured. Add GROQ_API_KEY to your Vercel environment variables." });

  let input;
  try {
    input = JSON.parse(await readBody(request));
  } catch (error) {
    return response.status(400).json({ error: error.message || "Send a valid JSON edit instruction." });
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt || prompt.length > 2000) return response.status(400).json({ error: "Enter an edit instruction between 1 and 2000 characters." });
  const duration = Number.isFinite(input.duration) ? Math.max(0, Math.min(input.duration, 86400)) : null;

  try {
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: [
              "You are a video editing assistant. Select exactly one supported action based on the user's instruction.",
              'Return only a JSON object with keys "action", "reply", "start", "end", "ratio", "language".',
              'Actions: "trim" (start/end are seconds), "aspect_ratio" (ratio is "16:9", "9:16", or "1:1"), "translate" (language is a target language), or "unknown".',
              "Never invent capabilities or claim an edit was done. If unsupported or ambiguous, use action unknown and briefly suggest a supported request.",
              `Video duration in seconds: ${duration === null ? "unknown (audio-only project)" : duration}.`,
            ].join(" "),
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: "json_object" },
      }),
    });
    if (!groqResponse.ok) {
      const body = await groqResponse.text();
      console.error("Groq edit assistant error:", groqResponse.status, body.slice(0, 1000));
      return response.status(502).json({ error: "The AI edit assistant could not process that instruction." });
    }
    const content = (await groqResponse.json()).choices?.[0]?.message?.content;
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      return response.status(502).json({ error: "The AI returned an invalid edit instruction. Please try rephrasing it." });
    }
    const action = ["trim", "aspect_ratio", "translate", "unknown"].includes(result.action) ? result.action : "unknown";
    const safeReply = typeof result.reply === "string" ? result.reply.slice(0, 240) : "";
    const edit = { action, reply: safeReply };
    if (action === "trim") {
      const start = Number(result.start);
      const end = Number(result.end);
      if (duration === null || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) {
        return response.status(422).json({ error: "I couldn't make a valid trim range from that instruction. Specify seconds within the video duration." });
      }
      edit.start = start;
      edit.end = end;
    } else if (action === "aspect_ratio") {
      if (!ASPECT_RATIOS.has(result.ratio)) return response.status(422).json({ error: "Choose a supported aspect ratio: 16:9, 9:16, or 1:1." });
      edit.ratio = result.ratio;
    } else if (action === "translate") {
      if (typeof result.language !== "string" || !result.language.trim() || result.language.length > 50) {
        return response.status(422).json({ error: "Tell me which language to translate into." });
      }
      edit.language = result.language.trim();
    }
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json(edit);
  } catch (error) {
    console.error("Unexpected AI editing error:", error);
    return response.status(502).json({ error: "The AI edit assistant could not process that instruction." });
  }
};
