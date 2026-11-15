/* =========================================================
   Frame — home view controller
   Switches between the landing page and the studio.
   ========================================================= */
(() => {
  const shell = document.querySelector(".app-shell");
  const home = document.querySelector("#home-view");
  const studio = document.querySelector("#studio-view");
  const navLinks = Array.from(document.querySelectorAll(".nav-link"));
  const promptForm = document.querySelector("#home-prompt-form");
  const promptInput = document.querySelector("#home-prompt");
  const aiPrompt = document.querySelector("#ai-edit-prompt");
  const targetLanguage = document.querySelector("#target-language");
  const aspectRatio = document.querySelector("#aspect-ratio");
  const videoInput = document.querySelector("#video-input");
  const audioInput = document.querySelector("#audio-input");

  const hasMedia = () => Number(document.querySelector("#media-count").textContent || 0) > 0;
  const notify = (message, isError = false) => {
    if (typeof window.showToast === "function") window.showToast(message, isError);
  };

  function setView(view, { scroll = true } = {}) {
    const isHome = view === "home";
    home.hidden = !isHome;
    studio.hidden = isHome;
    shell.classList.toggle("is-home", isHome);
    if (isHome) document.querySelectorAll("video, audio").forEach((media) => media.pause?.());
    navLinks.forEach((link) => {
      if (link.dataset.view) link.classList.toggle("is-active", link.dataset.view === view);
      else if (isHome) link.classList.remove("is-active");
    });
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }
  window.frameShowView = setView;

  function scrollToSection(id) {
    setView("home", { scroll: false });
    requestAnimationFrame(() => {
      document.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function focusStudio(selector) {
    setView("studio");
    requestAnimationFrame(() => {
      const target = document.querySelector(selector);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus?.({ preventScroll: true });
    });
  }

  // ---- Primary navigation ----
  document.querySelector("#brand-home")?.addEventListener("click", (event) => {
    event.preventDefault();
    setView("home");
  });

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      if (link.dataset.view) setView(link.dataset.view);
      else if (link.dataset.scroll) scrollToSection(link.dataset.scroll);
    });
  });

  // ---- Hero + CTA buttons ----
  document.querySelector("#hero-upload")?.addEventListener("click", () => videoInput.click());
  document.querySelector("#hero-studio")?.addEventListener("click", () => setView("studio"));
  document.querySelector("#home-cta-upload")?.addEventListener("click", () => videoInput.click());
  document.querySelector("#home-cta-studio")?.addEventListener("click", () => setView("studio"));

  // ---- Quick start cards ----
  document.querySelectorAll("[data-action]").forEach((card) => {
    card.addEventListener("click", () => {
      const action = card.dataset.action;
      if (action === "video") return videoInput.click();
      if (action === "audio") return audioInput.click();

      if (action === "translate") {
        if (!hasMedia()) {
          notify("Import a clip first — then Frame can dub it.");
          videoInput.click();
          return;
        }
        focusStudio("#target-language");
        return;
      }
      if (action === "edit") {
        if (!hasMedia()) notify("Import a clip to use the AI edit assistant.");
        focusStudio("#ai-edit-prompt");
        return;
      }
      if (action === "trim") {
        if (!hasMedia()) notify("Import a video to start trimming.");
        focusStudio("#split-button");
        return;
      }
      if (action === "canvas") {
        if (!hasMedia()) notify("Import a clip to change its canvas.");
        focusStudio("#aspect-ratio");
      }
    });
  });

  // ---- Templates ----
  document.querySelectorAll(".template-card").forEach((card) => {
    card.addEventListener("click", () => {
      notify(`“${card.dataset.template}” template selected — import a clip to make it yours.`);
      videoInput.click();
    });
  });

  // ---- Prompt dock ----
  document.querySelectorAll("[data-prompt]").forEach((chip) => {
    chip.addEventListener("click", () => {
      promptInput.value = chip.dataset.prompt;
      promptInput.focus();
    });
  });

  promptForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = promptInput.value.trim();
    if (!prompt) {
      notify("Describe the edit you want first.", true);
      promptInput.focus();
      return;
    }
    if (aiPrompt) aiPrompt.value = prompt;
    setView("studio");
    requestAnimationFrame(() => {
      aiPrompt?.focus();
      aiPrompt?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    if (hasMedia()) {
      notify("Prompt loaded into the AI edit assistant. Press “Suggest & apply edit”.");
    } else {
      notify("Prompt saved — import a clip, then apply it from the AI edit panel.");
    }
  });

  // ---- Small quality-of-life touches ----
  document.querySelectorAll(".quick-card, .template-card, .feature-link, .home-cta .button").forEach((element) => {
    element.addEventListener("pointerdown", () => element.classList.add("is-pressed"));
    ["pointerup", "pointerleave", "blur"].forEach((type) =>
      element.addEventListener(type, () => element.classList.remove("is-pressed"))
    );
  });

  // Start on the home page.
  setView("home", { scroll: false });
})();
