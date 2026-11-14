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
let toastTimer;
let trimStart = 0;
let trimEnd = 0;
let timelineZoom = 1;
let recording = null;
let audioContext = null;
let dubbed = false;

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "00:00";
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
};

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
  item.innerHTML = `<div class="media-thumb ${type === "audio" ? "audio-thumb" : ""}">${type === "audio" ? "♫" : "▶"}</div><div class="media-info"><strong></strong><span></span></div>`;
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
  translateButton.disabled = !file || $("#translation-progress").hidden === false;
  translateButton.title = file ? "" : "Import an audio or video file first.";
}

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

video.addEventListener("timeupdate", () => {
  $("#current-time").textContent = formatTime(video.currentTime);
  const duration = video.duration || 1;
  const percentage = Math.min(100, Math.max(0, (video.currentTime / duration) * 100));
  $("#playhead").style.left = `calc(66px + (100% - 66px) * ${percentage / 100})`;
  if (recording && video.currentTime >= trimEnd) video.pause();
});
video.addEventListener("ended", () => $("#play-button").textContent = "▶");
video.addEventListener("play", () => $("#play-button").textContent = "Ⅱ");
video.addEventListener("pause", () => $("#play-button").textContent = "▶");
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
  $("#volume-button").textContent = video.muted ? "◌" : "◖";
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
  if (typeof video.captureStream !== "function" && typeof video.mozCaptureStream !== "function") {
    throw new Error("This browser can't capture video audio. Try Chrome, Edge, or Firefox, or import an audio file instead.");
  }
  if (!video.duration || !Number.isFinite(video.duration)) throw new Error("Wait for the video to finish loading, then try again.");
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
  video.pause();
  video.muted = false;
  video.currentTime = trimStart;
  const seekCompleted = new Promise((resolve, reject) => {
    video.addEventListener("seeked", resolve, { once: true });
    setTimeout(() => {
      if (video.currentTime === trimStart) resolve();
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
  if (video.currentTime < trimEnd) await playbackEnded;
  if (recorder.state !== "inactive") recorder.stop();
  const blob = await completed;
  recording = null;
  stream.getTracks().forEach((track) => track.stop());
  video.pause();
  video.muted = originalMuted;
  seekTo(originalTime);
  if (wasPlaying) video.play().catch(() => {});
  if (blob.size === 0) throw new Error("The audio recording is empty. Check that the selected video section has audio.");
  return blob;
}

async function requestTranslation(blob, language, voice) {
  const response = await fetch(`/api/translate?language=${encodeURIComponent(language)}&voice=${encodeURIComponent(voice)}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Translation failed (${response.status}).`);
  }
  let translatedText = "";
  try {
    translatedText = decodeURIComponent(response.headers.get("x-translated-text") || "");
  } catch {
    translatedText = "The audio was translated successfully.";
  }
  const audioBlob = await response.blob();
  if (!audioBlob.size) throw new Error("The translation response did not contain audio.");
  return { audioBlob, translatedText };
}

translateButton.addEventListener("click", async () => {
  const sourceFile = sourceChoice.value === "audio" ? audioFile : videoFile;
  if (!sourceFile) return showToast("Import a video or audio file first.", true);
  $("#translation-progress").hidden = false;
  $("#translation-result").hidden = true;
  translateButton.disabled = true;
  $("#progress-label").textContent = sourceChoice.value === "video" ? "Capturing video audio…" : "Transcribing and translating…";
  try {
    const blob = sourceChoice.value === "video" ? await getSelectedAudioBlob() : sourceFile;
    if (blob.size > 4 * 1024 * 1024) {
      throw new Error("This Vercel setup accepts audio up to 4 MiB per request. Choose a shorter section, or use a storage-backed deployment for longer audio.");
    }
    $("#progress-label").textContent = "Transcribing, translating, and generating voice…";
    const result = await requestTranslation(blob, $("#target-language").value, $("#voice-select").value);
    if (translatedUrl) URL.revokeObjectURL(translatedUrl);
    translatedUrl = URL.createObjectURL(result.audioBlob);
    $("#translated-audio").src = translatedUrl;
    $("#download-audio").href = translatedUrl;
    $("#download-audio").download = `translated-${$("#target-language").value.toLowerCase()}.mp3`;
    $("#result-language").textContent = `AI voiceover · ${$("#target-language").value}`;
    $("#translated-transcript").textContent = result.translatedText || "Transcript is available in the translated audio.";
    $("#translation-result").hidden = false;
    $("#apply-dub-button").hidden = !videoFile;
    $("#audio-lane").innerHTML = '<div class="audio-clip"></div>';
    refreshTimeline();
    showToast("Translation is ready to preview and download.");
  } catch (error) {
    showToast(error.message || "Audio translation failed.", true);
  } finally {
    recording = null;
    $("#translation-progress").hidden = true;
    updateTranslateButton();
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

async function exportVideo() {
  if (!videoFile || !Number.isFinite(video.duration)) return;
  if (typeof video.captureStream !== "function" && typeof video.mozCaptureStream !== "function") {
    return showToast("This browser doesn't support video capture. Use Chrome, Edge, or Firefox.", true);
  }
  const videoStream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
  let audioStream;
  let destination;
  let translatedAudio;
  const tracks = videoStream.getVideoTracks();
  if (dubbed && translatedUrl) {
    translatedAudio = $("#translated-audio");
    try {
      audioContext ||= new AudioContext();
      await audioContext.resume();
      destination = audioContext.createMediaStreamDestination();
      const source = audioContext.createMediaElementSource(translatedAudio);
      source.connect(destination);
      source.connect(audioContext.destination);
      audioStream = destination.stream;
      tracks.push(...audioStream.getAudioTracks());
    } catch (error) {
      videoStream.getTracks().forEach((track) => track.stop());
      return showToast(`Could not prepare translated audio: ${error.message}`, true);
    }
  } else {
    tracks.push(...getPlayableAudioTrack(videoStream));
  }
  const stream = new MediaStream(tracks);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  const originalTime = video.currentTime;
  const originalMuted = video.muted;
  const wasPlaying = !video.paused;
  video.pause();
  if (translatedAudio) {
    translatedAudio.pause();
    translatedAudio.currentTime = 0;
    const clipDuration = trimEnd - trimStart;
    if (Number.isFinite(translatedAudio.duration) && translatedAudio.duration > 0) {
      translatedAudio.playbackRate = Math.min(2, Math.max(0.5, translatedAudio.duration / clipDuration));
    }
  } else video.muted = false;
  video.currentTime = trimStart;
  exportButton.disabled = true;
  exportButton.textContent = "Recording…";
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
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = () => reject(new Error("The video export recording failed."));
  });
  recorder.start(1000);
  if (translatedAudio) translatedAudio.play().catch(() => {});
  try {
    await video.play();
    if (video.currentTime < trimEnd) await playbackEnded;
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
    showToast("Your edited clip has been downloaded.");
  } catch (error) {
    if (recorder.state !== "inactive") recorder.stop();
    await stopped.catch(() => {});
    showToast(error.message || "Video export failed.", true);
  } finally {
    translatedAudio?.pause();
    if (translatedAudio) translatedAudio.playbackRate = 1;
    video.pause();
    video.muted = originalMuted;
    seekTo(originalTime);
    stream.getTracks().forEach((track) => track.stop());
    if (wasPlaying && !dubbed) video.play().catch(() => {});
    exportButton.disabled = false;
    exportButton.innerHTML = '<span class="export-icon">↗</span> Export video';
  }
}
exportButton.addEventListener("click", exportVideo);

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    $("#play-button").click();
  } else if (event.code === "ArrowLeft") {
    seekTo(video.currentTime - 5);
  } else if (event.code === "ArrowRight") {
    seekTo(video.currentTime + 5);
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
