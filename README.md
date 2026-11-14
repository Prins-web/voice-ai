# Frame — Video Studio

A browser-based video editor starter with local video preview, trim controls, audio translation, voiceover preview, and WebM export.

## Run locally

The editor can run as static files, but audio translation requires the API endpoint and an OpenAI API key. Use Vercel's local development server:

1. Install the Vercel CLI: `npm install --global vercel`
2. Link this folder to a Vercel project: `vercel link`
3. Add `OPENAI_API_KEY` to the project's development environment with `vercel env add OPENAI_API_KEY development`.
4. Run `vercel dev`.

The key is only used by the serverless API; do not put it in `app.js` or other browser files.

## Deploy to Vercel

Push this folder to a GitHub repository, import it into Vercel, and set `OPENAI_API_KEY` under **Project Settings → Environment Variables**. Redeploy after adding the key. No build command or framework preset is required.

## Features and limits

- Video and audio are loaded locally in the browser; there is no app-level 500 MB video upload cap. The exact file size a device can play/edit depends on available memory, browser support, codec, and device performance. When you request AI translation, the selected audio is sent to the Vercel endpoint and OpenAI; video editing itself remains local.
- The editor previews video, sets an in/out range, and exports the selected section as WebM by recording browser playback. Export takes approximately as long as the selected section and depends on MediaRecorder support. It is not a frame-accurate, lossless editing pipeline.
- Video audio is captured from playback for translation; standalone audio files can also be translated. The translated voiceover can be previewed over a muted video or downloaded separately.
- Translation auto-transcribes with OpenAI Whisper, translates with GPT-4o mini, and generates speech with OpenAI TTS. Speech translation is probabilistic; review the transcript and voiceover before publishing.
- Vercel serverless request limits apply independently of the browser editor. This endpoint caps the request body at 4 MiB to avoid consuming the platform's request allowance; long video audio needs a storage-backed processing service or a different deployment architecture. The speech endpoint also has text-length limits.
- AI translation is optional and incurs OpenAI API charges. Check current provider pricing and availability before deployment.
