# Frame — Video Studio

A browser-based video editor starter with local video preview, trim controls, audio translation, voiceover preview, and WebM export.

The app opens on a landing page with a prompt dock, quick-start tools, a template gallery, and a feature tour. Importing a video or audio file switches straight into the studio; use the header navigation to move between Home and Studio at any time.

## Run locally

The editor can run as static files, but AI translation and editing require a Groq API key. Use Vercel's local development server:

1. Install the Vercel CLI: `npm install --global vercel`
2. Link this folder to a Vercel project: `vercel link`
3. Add `GROQ_API_KEY` to the project's development environment with `vercel env add GROQ_API_KEY development`.
4. Run `vercel dev`.

The key is only used by the serverless API; do not put it in `app.js` or other browser files.

## Deploy to Vercel

Push this folder to a GitHub repository, import it into Vercel, and set `GROQ_API_KEY` under **Project Settings → Environment Variables**. Redeploy after adding the key. No build command or framework preset is required. Never paste an API key into client-side files or commit it to GitHub. If a key has been shared in chat or another public place, revoke it and create a replacement.

## Features and limits

- Video and audio are loaded locally in the browser; there is no app-level 500 MB video upload cap. The exact file size a device can play/edit depends on available memory, browser support, codec, and device performance. When you request AI translation or editing, the audio or text prompt is sent to Vercel and Groq; video editing itself remains local.
- The editor previews video, sets an in/out range, and exports the selected section as WebM by recording browser playback. Export takes approximately as long as the selected section and depends on MediaRecorder support. It is not a frame-accurate, lossless editing pipeline.
- Translation extracts audio locally with the Web Audio API (decoded and re-encoded as mono WAV at 16 kHz, stepping down to 12 or 8 kHz for longer sections) instead of recording playback in real time, so preparing a clip takes under a second rather than the length of the video. Sections up to roughly four minutes fit the 4 MiB request cap this way. Standalone audio files can also be translated, and real-time capture remains only as a fallback when the browser cannot decode the track.
- Translation auto-transcribes with Groq's `whisper-large-v3-turbo` and translates with `llama-3.1-8b-instant`, automatically retrying with `llama-3.3-70b-versatile` if the faster model is unavailable. The language input accepts common suggestions and custom language names. Review the transcript before publishing; no machine translation can guarantee zero errors.
- Long-running AI requests show a live progress label with elapsed time and abort after three minutes, so a stalled request surfaces an error instead of hanging the UI.
- Groq's hosted speech generation currently supports English and Saudi Arabic, with a 200-character input limit. Other languages still receive a translated transcript that can be downloaded, but not a generated voiceover from this provider.
- The AI edit assistant can set a video trim range, change the canvas ratio, or start an audio translation from a text instruction. Unsupported requests are not applied. Review suggested edits before exporting.
- Vercel serverless request limits apply independently of the browser editor. The translation endpoint caps audio at 4 MiB, and the edit instruction at 8 KiB; longer audio needs a storage-backed processing service or a different deployment architecture.
- AI features use your Groq account and may incur charges subject to current model access, rate limits, and pricing. Check Groq's current model documentation before deployment.
