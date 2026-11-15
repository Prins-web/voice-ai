const $ = (selector) => document.querySelector(selector);
const videoInput = $("#video-input");
const audioInput = $("#audio-input");
const video = $("#video-player");
const audio = $("#audio-player");
const sourceChoice = $("#source-choice");
const translateButton = $("#translate-button");
const exportButton = $("#export-button");
let videoFile = null;
let audioFile = null;
let videoUrl = null;
let audioUrl = null;
let translatedUrl = null;
let transcriptUrl = null;
let toastTimer;
let trimStart = 0;
let trimEnd = 0;
let timelineZoom = 1;
let recording = null;
let audioContext = null;
let audioDestination = null;
let audioSource = null;
let exporting = false;
let dubbed = false;

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const FAST_EXTRACT_FILE_LIMIT = 320 * 1024 * 1024;
const FAST_EXTRACT_SAMPLE_RATE = 16000;
const FAST_EXTRACT_MIN_SAMPLE_RATE = 8000;

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* ---- Progress feedback -------------------------------------------------- */
let progressTimer = null;
let progressStart = 0;
let progressBase = "";
let progressDetail = "";

function paintProgress() {
  const label = $("#progress-label");
  if (!label) return;
  const seconds = Math.floor((performance.now() - progressStart) / 1000);
  const time = seconds > 0 ? ` · ${seconds}s` : "";
  label.textContent = `${progressBase}${progressDetail ? ` · ${progressDetail}` : ""}${time}`;
}

function setProgressLabel(base, detail = "") {
  progressBase = base;
  progressDetail = detail;
  paintProgress();
}

function startProgressClock() {
  progressStart = performance.now();
  clearInterval(progressTimer);
  progressTimer = setInterval(paintProgress, 500);
}

function stopProgressClock() {
  clearInterval(progressTimer);
  progressTimer = null;
}

/* ---- Fast, non-realtime audio extraction --------------------------------
   Decoding the container and slicing the trim range locally takes a few
   hundred milliseconds, instead of recording the section in real time. */
function encodeWavMono(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index], -1, 1);
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function renderWavSlice(decoded, startSeconds, endSeconds, maxBytes = Infinity) {
  const duration = decoded.duration;
  const start = clamp(startSeconds, 0, duration);
  const end = clamp(endSeconds, start + 0.05, duration);
  if (!(end > start)) return null;
  const sourceRate = decoded.sampleRate;
  const startSample = Math.floor(start * sourceRate);
  const endSample = Math.min(decoded.length, Math.ceil(end * sourceRate));
  const sourceCount = endSample - startSample;
  if (sourceCount <= 0) return null;
  const seconds = sourceCount / sourceRate;
  // Keep the best quality that still fits the request cap. Lower rates still
  // transcribe well and let clips up to roughly four minutes skip real-time capture.
  const candidates = [FAST_EXTRACT_SAMPLE_RATE, 12000, FAST_EXTRACT_MIN_SAMPLE_RATE].filter((rate) => rate <= sourceRate);
  if (sourceRate < FAST_EXTRACT_MIN_SAMPLE_RATE) candidates.push(sourceRate);
  const targetRate = [...new Set(candidates)]
    .sort((a, b) => b - a)
    .find((rate) => 44 + Math.floor(seconds * rate) * 2 <= maxBytes);
  if (!targetRate) return null;
  const step = sourceRate / targetRate;
  const outputLength = Math.floor(sourceCount / step);
  if (outputLength <= 0) return null;
  const channels = decoded.numberOfChannels;
  const channelData = [];
  for (let channel = 0; channel < channels; channel += 1) channelData.push(decoded.getChannelData(channel));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const from = startSample + Math.floor(index * step);
    const to = Math.min(endSample, Math.max(from + 1, startSample + Math.floor((index + 1) * step)));
    let sum = 0;
    let count = 0;
    for (let sample = from; sample < to; sample += 1) {
      for (let channel = 0; channel < channels; channel += 1) sum += channelData[channel][sample] || 0;
      count += channels;
    }
    output[index] = count ? sum / count : 0;
  }
  return encodeWavMono(output, targetRate);
}

async function extractAudioFast(file, start, end) {
  if (!file || file.size > FAST_EXTRACT_FILE_LIMIT) return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || typeof file.arrayBuffer !== "function") return null;
  let context;
  try {
    context = new AudioContextClass();
    const encoded = await file.arrayBuffer();
    const decoded = await new Promise((resolve, reject) => {
      const result = context.decodeAudioData(encoded, resolve, reject);
      if (result && typeof result.then === "function") result.then(resolve, reject);
    });
    const blob = renderWavSlice(decoded, start, end, MAX_UPLOAD_BYTES);
    if (!blob || blob.size > MAX_UPLOAD_BYTES) return null;
    return blob;
  } catch (error) {
    console.warn("Fast audio extraction is unavailable, using real-time capture instead.", error);
    return null;
  } finally {
    context?.close?.().catch(() => {});
  }
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3300);
}

function addMediaItem(file, type) {
  const list = $("#media-list");
  list.querySelector(".empty-media")?.remove();
  const item = document.createElement("div");
  item.className = "media-item selected";
  const icon = type === "audio" ? "i-music" : "i-video";
  item.innerHTML = `<div class="media-thumb ${type === "audio" ? "audio-thumb" : ""}"><svg class="icon"><use href="#${icon}"></use></svg></div><div class="media-info"><strong></strong><span></span></div>`;
  item.querySelector("strong").textContent = file.name;
  item.querySelector("span").textContent = `${type === "audio" ? "Audio" : "Video"} · ${formatBytes(file.size)}`;
  list.querySelectorAll(".media-item").forEach((el) => el.classList.remove("selected"));
  list.append(item);
  $("#media-count").textContent = list.querySelectorAll(".media-item").length;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateSourceOptions() {
  sourceChoice.innerHTML = "";
  if (videoFile) sourceChoice.add(new Option(`Video audio · ${videoFile.name}`, "video"));
  if (audioFile) sourceChoice.add(new Option(`Audio file · ${audioFile.name}`, "audio"));
  if (!videoFile && !audioFile) sourceChoice.add(new Option("Import media to begin", ""));
  sourceChoice.disabled = !videoFile && !audioFile;
  $("#source-hint").textContent = videoFile || audioFile
    ? "Choose which audio to transcribe. The source stays on your device."
    : "Import a video or audio file to begin.";
  updateTranslateButton();
}

function updateTranslateButton() {
  const file = sourceChoice.value === "video" ? videoFile : audioFile;
  const language = $("#target-language").value.trim();
  translateButton.disabled = !file || !language || $("#translation-progress").hidden === false;
  translateButton.title = file ? "" : "Import an audio or video file first.";
}

$("#target-language").addEventListener("input", updateTranslateButton);
$("#target-language").addEventListener("change", () => {
  const isArabic = ["arabic", "ar"].includes($("#target-language").value.trim().toLowerCase());
  const arabicVoices = ["fahad", "lulwa", "noura", "abdullah", "sultan", "aisha"];
  const englishVoices = ["hannah", "troy", "austin", "autumn", "diana"];
  if (isArabic && !arabicVoices.includes($("#voice-select").value)) $("#voice-select").value = "fahad";
  if (!isArabic && arabicVoices.includes($("#voice-select").value)) $("#voice-select").value = "hannah";
});

function setupVideo(file) {
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoFile = file;
  videoUrl = URL.createObjectURL(file);
  video.src = videoUrl;
  video.load();
  $("#preview-empty").hidden = true;
  $("#audio-preview").hidden = true;
  $("#player-wrap").hidden = false;
  $("#project-name").textContent = file.name;
  $("#video-badge").textContent = "ORIGINAL";
  $("#dub-badge").hidden = true;
  dubbed = false;
  trimStart = 0;
  $("#trim-start").value = "0";
  $("#trim-controls").hidden = false;
  $("#export-button").disabled = false;
  $("#split-button").disabled = false;
  $("#delete-button").disabled = false;
  $("#track-lane").innerHTML = '<div class="video-clip"></div>';
  $("#audio-lane").innerHTML = '<div class="timeline-empty audio-empty">Audio will be translated here</div>';
  sourceChoice.value = "video";
  addMediaItem(file, "video");
  updateSourceOptions();
  window.frameShowView?.("studio");
}

function setupAudio(file) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioFile = file;
  audioUrl = URL.createObjectURL(file);
  audio.src = audioUrl;
  $("#audio-preview-title").textContent = file.name;
  $("#preview-empty").hidden = true;
  $("#player-wrap").hidden = true;
  $("#audio-preview").hidden = false;
  $("#project-name").textContent = file.name;
  $("#trim-controls").hidden = true;
  $("#export-button").disabled = true;
  sourceChoice.value = "audio";
  $("#audio-lane").innerHTML = '<div class="audio-clip"></div>';
  addMediaItem(file, "audio");
  updateSourceOptions();
  window.frameShowView?.("studio");
}

videoInput.addEventListener("change", () => {
  const file = videoInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("video/")) return showToast("Choose a video file to import.", true);
  setupVideo(file);
  showToast("Video imported. It stays on your device.");
  videoInput.value = "";
});

audioInput.addEventListener("change", () => {
  const file = audioInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("audio/")) return showToast("Choose an audio file to import.", true);
  setupAudio(file);
  showToast("Audio imported. Ready to translate.");
  audioInput.value = "";
});

$("#upload-button").addEventListener("click", () => videoInput.click());
$("#add-media-button").addEventListener("click", () => videoInput.click());
$("#empty-upload-button").addEventListener("click", () => videoInput.click());
$("#translate-tab").addEventListener("click", () => $("#target-language").focus());
$("#source-hint").addEventListener("click", () => {
  if (!videoFile && !audioFile) videoInput.click();
});
sourceChoice.addEventListener("change", updateTranslateButton);

video.addEventListener("loadedmetadata", () => {
  $("#duration-time").textContent = formatTime(video.duration);
  trimEnd = video.duration;
  $("#trim-end").max = String(video.duration);
  $("#trim-end").value = String(video.duration.toFixed(1));
  $("#trim-start").max = String(video.duration);
  $("#ruler").innerHTML = "";
  const count = 6;
  for (let i = 0; i <= count; i++) {
    const mark = document.createElement("span");
    mark.textContent = formatTime((video.duration / count) * i);
    $("#ruler").append(mark);
  }
  $("#video-badge").textContent = video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : "VIDEO";
  refreshTimeline();
});

function updatePlayhead() {
  const duration = video.duration || 1;
  const percentage = clamp(Number.isFinite(duration) ? video.currentTime / duration : 0, 0, 1);
  const playhead = $("#playhead");
  if (playhead) playhead.style.left = `calc(66px + (100% - 66px) * ${percentage})`;
  const current = $("#current-time");
  if (current) current.textContent = formatTime(video.currentTime);
}

let playheadFrame = null;
function animatePlayhead() {
  updatePlayhead();
  playheadFrame = video.paused ? null : requestAnimationFrame(animatePlayhead);
}

function setPlayIcon(isPlaying) {
  const button = $("#play-button");
  button.querySelector("use")?.setAttribute("href", isPlaying ? "#i-pause" : "#i-play");
  button.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

function setVolumeIcon() {
  const button = $("#volume-button");
  const muted = video.muted || video.volume === 0;
  button.querySelector("use")?.setAttribute("href", muted ? "#i-mute" : "#i-volume");
  button.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  button.title = muted ? "Unmute" : "Mute";
}

video.addEventListener("timeupdate", () => {
  updatePlayhead();
  if (recording && video.currentTime >= trimEnd) video.pause();
});
video.addEventListener("ended", () => setPlayIcon(false));
video.addEventListener("play", () => {
  setPlayIcon(true);
  if (playheadFrame === null) playheadFrame = requestAnimationFrame(animatePlayhead);
});
video.addEventListener("pause", () => setPlayIcon(false));
video.addEventListener("seeked", updatePlayhead);
video.addEventListener("durationchange", refreshTimeline);

function refreshTimeline() {
  const duration = video.duration || 1;
  const width = Math.min(100, Math.max(8, ((trimEnd - trimStart) / duration) * 100 * timelineZoom));
  const clip = $("#track-lane .video-clip");
  if (clip) {
    clip.style.left = `${(trimStart / duration) * 100}%`;
    clip.style.width = `${width}%`;
  }
  const audioClip = $("#audio-lane .audio-clip");
  if (audioClip) audioClip.style.width = `${width}%`;
}

function seekTo(seconds) {
  if (!Number.isFinite(video.duration)) return;
  video.currentTime = Math.min(video.duration, Math.max(0, seconds));
}

$("#play-button").addEventListener("click", () => {
  if (!videoFile) return;
  if (video.paused) {
    if (video.currentTime < trimStart || video.currentTime >= trimEnd) seekTo(trimStart);
    video.play().catch(() => showToast("Your browser couldn't play this video.", true));
  } else video.pause();
});
$("#skip-back").addEventListener("click", () => seekTo(video.currentTime - 5));
$("#skip-forward").addEventListener("click", () => seekTo(video.currentTime + 5));
$("#volume-slider").addEventListener("input", (event) => {
  video.volume = Number(event.target.value);
  video.muted = video.volume === 0;
});
$("#volume-button").addEventListener("click", () => {
  video.muted = !video.muted;
});
video.addEventListener("volumechange", setVolumeIcon);
video.addEventListener("click", () => {
  if (videoFile) $("#play-button").click();
});
$("#timeline-content").addEventListener("click", (event) => {
  if (!videoFile || !Number.isFinite(video.duration)) return;
  const lane = event.target.closest(".track-lane");
  if (!lane) return;
  const rect = lane.getBoundingClientRect();
  if (!rect.width) return;
  seekTo(((event.clientX - rect.left) / rect.width) * video.duration);
});
$("#fullscreen-button").addEventListener("click", () => {
  if (videoFile && video.requestFullscreen) video.requestFullscreen().catch(() => {});
});
$("#aspect-ratio").addEventListener("change", (event) => {
  const [width, height] = event.target.value.split(":").map(Number);
  $("#player-wrap").style.aspectRatio = `${width}/${height}`;
});
$("#zoom-in").addEventListener("click", () => {
  timelineZoom = Math.min(3, timelineZoom + 0.25);
  $("#zoom-level").textContent = `${Math.round(timelineZoom * 100)}%`;
  refreshTimeline();
});
$("#zoom-out").addEventListener("click", () => {
  timelineZoom = Math.max(0.5, timelineZoom - 0.25);
  $("#zoom-level").textContent = `${Math.round(timelineZoom * 100)}%`;
  refreshTimeline();
});
$("#trim-start").addEventListener("change", (event) => {
  const value = Number(event.target.value);
  trimStart = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : 0, value));
  if (trimStart >= trimEnd) trimStart = Math.max(0, trimEnd - 0.1);
  event.target.value = trimStart.toFixed(1);
  if (video.currentTime < trimStart) seekTo(trimStart);
  refreshTimeline();
});
$("#trim-end").addEventListener("change", (event) => {
  const value = Number(event.target.value);
  trimEnd = Math.max(trimStart + 0.1, Math.min(Number.isFinite(video.duration) ? video.duration : 0, value));
  event.target.value = trimEnd.toFixed(1);
  if (video.currentTime > trimEnd) seekTo(trimEnd);
  refreshTimeline();
});
$("#reset-trim").addEventListener("click", () => {
  trimStart = 0;
  trimEnd = video.duration;
  $("#trim-start").value = "0";
  $("#trim-end").value = trimEnd.toFixed(1);
  refreshTimeline();
});
$("#split-button").addEventListener("click", () => {
  const time = video.currentTime;
  if (time <= trimStart || time > video.duration) return showToast("Move the playhead after the In point to set the Out point.");
  trimEnd = time;
  $("#trim-end").value = trimEnd.toFixed(1);
  refreshTimeline();
  showToast(`Out point set at ${formatTime(time)}.`);
});
$("#delete-button").addEventListener("click", () => {
  if (!videoFile) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
  URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  videoFile = null;
  $("#player-wrap").hidden = true;
  $("#preview-empty").hidden = false;
  $("#export-button").disabled = true;
  $("#trim-controls").hidden = true;
  $("#track-lane").innerHTML = '<div class="timeline-empty">Import a video to start your timeline</div>';
  $("#video-badge").textContent = "ORIGINAL";
  $("#dub-badge").hidden = true;
  dubbed = false;
  updateSourceOptions();
  showToast("Video removed from the timeline.");
});

function getPlayableAudioTrack(stream) {
  return stream?.getAudioTracks?.().length ? stream.getAudioTracks() : [];
}

async function getSelectedAudioBlob() {
  if (sourceChoice.value === "audio" && audioFile) return audioFile;
  if (!videoFile) throw new Error("Import a video or audio file first.");
  if (!video.duration || !Number.isFinite(video.duration)) throw new Error("Wait for the video to finish loading, then try again.");
  const start = clamp(trimStart, 0, video.duration);
  const end = clamp(trimEnd || video.duration, start + 0.05, video.duration);
  setProgressLabel("Preparing audio", "on device");
  const fastBlob = await extractAudioFast(videoFile, start, end);
  if (fastBlob) {
    setProgressLabel("Audio extracted", "on device");
    return fastBlob;
  }
  return captureSelectedAudio(start, end);
}

async function captureSelectedAudio(start, end) {
  if (typeof video.captureStream !== "function" && typeof video.mozCaptureStream !== "function") {
    throw new Error("This browser can't capture video audio. Try Chrome, Edge, or Firefox, or import an audio file instead.");
  }
  const capture = video.captureStream ? video.captureStream() : video.mozCaptureStream();
  const audioTracks = getPlayableAudioTrack(capture);
  if (!audioTracks.length) {
    capture.getTracks().forEach((track) => track.stop());
    throw new Error("No audio track was found. Import the audio separately if your video is silent.");
  }
  const stream = new MediaStream(audioTracks);
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  const originalTime = video.currentTime;
  const wasPlaying = !video.paused;
  const originalMuted = video.muted;
  const sectionLength = Math.max(0.1, end - start);
  setProgressLabel("Capturing video audio", "real-time");
  const progressInterval = setInterval(() => {
    const percentage = clamp(Math.round(((video.currentTime - start) / sectionLength) * 100), 0, 99);
    setProgressLabel("Capturing video audio", `${percentage}%`);
  }, 400);
  try {
    video.pause();
    video.muted = false;
    video.currentTime = start;
    const seekCompleted = new Promise((resolve, reject) => {
      video.addEventListener("seeked", resolve, { once: true });
      setTimeout(() => {
        if (Math.abs(video.currentTime - start) < 0.25) resolve();
        else reject(new Error("Could not seek to the selected video section."));
      }, 5000);
    });
    const playbackEnded = new Promise((resolve) => {
      video.addEventListener("pause", resolve, { once: true });
      video.addEventListener("ended", resolve, { once: true });
    });
    await seekCompleted;
    recording = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const completed = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      recorder.onerror = () => reject(new Error("Could not capture video audio."));
    });
    recorder.start(1000);
    await video.play();
    if (video.currentTime < end - 0.05) await playbackEnded;
    if (recorder.state !== "inactive") recorder.stop();
    const blob = await completed;
    setProgressLabel("Audio captured", "on device");
    if (blob.size === 0) throw new Error("The audio recording is empty. Check that the selected video section has audio.");
    return blob;
  } finally {
    clearInterval(progressInterval);
    recording = null;
    stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.muted = originalMuted;
    seekTo(originalTime);
    if (wasPlaying) video.play().catch(() => {});
  }
}

async function requestTranslation(blob, language, voice) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(`/api/translate?language=${encodeURIComponent(language)}&voice=${encodeURIComponent(voice)}`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Translation failed (${response.status}).`);
    }
    const result = await response.json();
    if (typeof result.translatedText !== "string" || !result.translatedText.trim()) {
      throw new Error("The translation service returned an empty transcript.");
    }
    const audioBlob = result.audioBase64
      ? new Blob([Uint8Array.from(atob(result.audioBase64), (character) => character.charCodeAt(0))], { type: result.audioMimeType || "audio/wav" })
      : null;
    return { audioBlob, translatedText: result.translatedText, audioUnavailableReason: result.audioUnavailableReason, timings: result.timings };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The AI request took too long and was cancelled. Try a shorter section.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function translateCurrentAudio() {
  const sourceFile = sourceChoice.value === "audio" ? audioFile : videoFile;
  if (!sourceFile) return showToast("Import a video or audio file first.", true);
  $("#translation-progress").hidden = false;
  $("#translation-result").hidden = true;
  translateButton.disabled = true;
  const startedAt = performance.now();
  startProgressClock();
  setProgressLabel(sourceChoice.value === "video" ? "Preparing video audio" : "Reading audio file", "on device");
  try {
    const blob = sourceChoice.value === "video" ? await getSelectedAudioBlob() : sourceFile;
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error("This Vercel setup accepts audio up to 4 MiB per request. Choose a shorter section, or use a storage-backed deployment for longer audio.");
    }
    setProgressLabel("Transcribing and translating", "AI processing");
    const language = $("#target-language").value.trim();
    const result = await requestTranslation(blob, language, $("#voice-select").value);
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = result.audioBlob ? URL.createObjectURL(result.audioBlob) : null;
    if (transcriptUrl) URL.revokeObjectURL(transcriptUrl);
    transcriptUrl = URL.createObjectURL(new Blob([result.translatedText], { type: "text/plain;charset=utf-8" }));
    const translatedAudio = $("#translated-audio");
    translatedAudio.hidden = !translatedUrl;
    if (translatedUrl) translatedAudio.src = translatedUrl;
    $("#download-audio").hidden = !translatedUrl;
    if (translatedUrl) {
      $("#download-audio").href = translatedUrl;
      $("#download-audio").download = `translated-${language.toLowerCase()}.wav`;
    }
    $("#download-transcript").href = transcriptUrl;
    $("#download-transcript").download = `translated-${language.toLowerCase()}-transcript.txt`;
    $("#audio-unavailable").textContent = result.audioUnavailableReason || "";
    $("#result-language").textContent = translatedUrl ? `Translated voiceover · ${language}` : `Translated text · ${language}`;
    $("#translated-transcript").textContent = result.translatedText;
    $("#translation-result").hidden = false;
    $("#apply-dub-button").hidden = !videoFile || !translatedUrl;
    if (translatedUrl) $("#audio-lane").innerHTML = '<div class="audio-clip"></div>';
    refreshTimeline();
    const seconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
    showToast(translatedUrl
      ? `Translation and voiceover ready in ${seconds}s.`
      : `Translation ready in ${seconds}s — download the transcript below.`);
  } catch (error) {
    showToast(error.message || "Audio translation failed.", true);
  } finally {
    stopProgressClock();
    recording = null;
    $("#translation-progress").hidden = true;
    updateTranslateButton();
  }
}
translateButton.addEventListener("click", translateCurrentAudio);

$("#ai-edit-button").addEventListener("click", async () => {
  const button = $("#ai-edit-button");
  const prompt = $("#ai-edit-prompt").value.trim();
  const status = $("#ai-edit-status");
  if (!prompt) {
    status.textContent = "Describe what you want to change first.";
    $("#ai-edit-prompt").focus();
    return;
  }
  button.disabled = true;
  status.textContent = "Thinking through your edit…";
  try {
    const response = await fetch("/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, duration: Number.isFinite(video.duration) ? video.duration : null }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `AI edit failed (${response.status}).`);
    if (result.action === "trim") {
      if (!videoFile || result.end > video.duration) throw new Error("Import a video before applying a trim.");
      trimStart = result.start;
      trimEnd = result.end;
      $("#trim-start").value = trimStart.toFixed(1);
      $("#trim-end").value = trimEnd.toFixed(1);
      $("#trim-controls").hidden = false;
      seekTo(trimStart);
      refreshTimeline();
      status.textContent = `${result.reply || "Trim range applied."} Review the In and Out values before exporting.`;
    } else if (result.action === "aspect_ratio") {
      $("#aspect-ratio").value = result.ratio;
      $("#aspect-ratio").dispatchEvent(new Event("change"));
      status.textContent = `${result.reply || "Canvas ratio changed."} Review the preview before exporting.`;
    } else if (result.action === "translate") {
      if (!videoFile && !audioFile) throw new Error("Import audio or video before requesting translation.");
      $("#target-language").value = result.language;
      updateTranslateButton();
      status.textContent = `${result.reply || `Translating to ${result.language}.`} Starting translation…`;
      await translateCurrentAudio();
    } else {
      status.textContent = result.reply || "Try asking for a trim range, canvas ratio, or audio translation.";
    }
  } catch (error) {
    status.textContent = error.message || "The AI edit assistant could not process that instruction.";
  } finally {
    button.disabled = false;
  }
});

$("#apply-dub-button").addEventListener("click", () => {
  if (!translatedUrl || !videoFile) return;
  const translatedAudio = $("#translated-audio");
  if (!dubbed) {
    video.muted = true;
    seekTo(trimStart);
    translatedAudio.currentTime = 0;
    const clipDuration = trimEnd - trimStart;
    if (Number.isFinite(translatedAudio.duration) && translatedAudio.duration > 0) {
      translatedAudio.playbackRate = Math.min(2, Math.max(0.5, translatedAudio.duration / clipDuration));
    }
    video.play().catch(() => showToast("Your browser couldn't play this video.", true));
    translatedAudio.play().catch(() => showToast("Press play on the translated audio player to start the preview.", true));
    $("#apply-dub-button").textContent = "Stop translated preview";
    $("#dub-badge").hidden = false;
    $("#video-badge").textContent = "VIDEO MUTED";
    dubbed = true;
  } else {
    translatedAudio.pause();
    translatedAudio.playbackRate = 1;
    video.muted = false;
    $("#apply-dub-button").textContent = "Preview with video";
    $("#dub-badge").hidden = true;
    $("#video-badge").textContent = "ORIGINAL";
    dubbed = false;
  }
});
$("#translated-audio").addEventListener("ended", () => {
  if (dubbed) $("#apply-dub-button").click();
});

function ensureTranslatedAudioGraph() {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  if (!audioSource) {
    audioSource = audioContext.createMediaElementSource($("#translated-audio"));
    audioDestination = audioContext.createMediaStreamDestination();
    audioSource.connect(audioDestination);
    audioSource.connect(audioContext.destination);
  }
  return audioDestination;
}

async function exportVideo() {
  if (exporting) return;
  if (!videoFile || !Number.isFinite(video.duration)) return;
  if (typeof video.captureStream !== "function" && typeof video.mozCaptureStream !== "function") {
    return showToast("This browser doesn't support video capture. Use Chrome, Edge, or Firefox.", true);
  }
  exporting = true;
  exportButton.disabled = true;
  const originalLabel = exportButton.innerHTML;
  const originalTime = video.currentTime;
  const originalMuted = video.muted;
  const wasPlaying = !video.paused;
  const clipStart = clamp(trimStart, 0, video.duration);
  const clipEnd = clamp(trimEnd || video.duration, clipStart + 0.1, video.duration);
  const clipLength = Math.max(0.1, clipEnd - clipStart);
  let videoStream = null;
  let translatedAudio = null;
  let recorder = null;
  let stopped = null;
  let progressInterval = null;
  try {
    videoStream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    const tracks = videoStream.getVideoTracks();
    if (dubbed && translatedUrl) {
      translatedAudio = $("#translated-audio");
      const destination = ensureTranslatedAudioGraph();
      await audioContext.resume();
      tracks.push(...destination.stream.getAudioTracks());
      translatedAudio.pause();
      translatedAudio.currentTime = 0;
      const rate = Number.isFinite(translatedAudio.duration) && translatedAudio.duration > 0
        ? translatedAudio.duration / clipLength
        : 1;
      translatedAudio.playbackRate = clamp(rate, 0.5, 2);
    } else {
      tracks.push(...getPlayableAudioTrack(videoStream));
      video.muted = false;
    }
    const stream = new MediaStream(tracks);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    video.pause();
    video.playbackRate = 1;
    video.currentTime = clipStart;
    exportButton.textContent = "Preparing export…";
    progressInterval = setInterval(() => {
      const done = clamp(video.currentTime - clipStart, 0, clipLength);
      const percentage = Math.round((done / clipLength) * 100);
      const remaining = Math.max(0, Math.ceil(clipLength - done));
      exportButton.textContent = `Exporting ${percentage}% · ${remaining}s left`;
    }, 250);
    const ready = new Promise((resolve) => {
      video.addEventListener("seeked", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
    await ready;
    const playbackEnded = new Promise((resolve) => {
      video.addEventListener("pause", resolve, { once: true });
      video.addEventListener("ended", resolve, { once: true });
    });
    recording = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error("The video export recording failed."));
    });
    recorder.start(1000);
    if (translatedAudio) translatedAudio.play().catch(() => {});
    await video.play();
    if (video.currentTime < clipEnd - 0.05) await playbackEnded;
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    const output = new Blob(chunks, { type: mimeType });
    if (!output.size) throw new Error("The exported video is empty.");
    const url = URL.createObjectURL(output);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${videoFile.name.replace(/\.[^.]+$/, "")}-edited.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    showToast(`Export complete — ${clipLength.toFixed(0)}s clip downloaded.`);
  } catch (error) {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    if (stopped) await stopped.catch(() => {});
    showToast(error.message || "Video export failed.", true);
  } finally {
    clearInterval(progressInterval);
    translatedAudio?.pause();
    if (translatedAudio) translatedAudio.playbackRate = 1;
    video.pause();
    video.playbackRate = 1;
    video.muted = originalMuted;
    seekTo(originalTime);
    const keepAlive = new Set(audioDestination ? audioDestination.stream.getTracks() : []);
    videoStream?.getTracks().forEach((track) => {
      if (!keepAlive.has(track)) track.stop();
    });
    if (wasPlaying && !dubbed) video.play().catch(() => {});
    exportButton.disabled = false;
    exportButton.innerHTML = originalLabel;
    exporting = false;
    recording = null;
  }
}
exportButton.addEventListener("click", exportVideo);

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
  const onHome = document.querySelector(".app-shell")?.classList.contains("is-home");
  if (event.code === "Space") {
    event.preventDefault();
    if (!onHome) $("#play-button").click();
  } else if (event.code === "ArrowLeft") {
    if (!onHome) seekTo(video.currentTime - 5);
  } else if (event.code === "ArrowRight") {
    if (!onHome) seekTo(video.currentTime + 5);
  } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    videoInput.click();
  } else if (event.key === "/") {
    $("#keyboard-modal").hidden = false;
  } else if (event.key === "Escape") {
    $("#keyboard-modal").hidden = true;
  }
});
$("#keyboard-help").addEventListener("click", () => $("#keyboard-modal").hidden = false);
$("#modal-close").addEventListener("click", () => $("#keyboard-modal").hidden = true);
$("#keyboard-modal").addEventListener("click", (event) => {
  if (event.target === $("#keyboard-modal")) $("#keyboard-modal").hidden = true;
});
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (file.type.startsWith("video/")) setupVideo(file);
  else if (file.type.startsWith("audio/")) setupAudio(file);
  else showToast("Choose a video or audio file to import.", true);
});

updateSourceOptions();
