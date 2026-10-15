(() => {
  type Settings = Record<string, any>;
  interface State {
    settings: Settings;
    defaults: Settings;
    detectors: { kind: string; title: string }[];
    defaultRules: { hide: string; keep: string };
    apiKey: { stored: boolean; canPersist: boolean; fromEnv: boolean };
    platform: string;
    version: string;
    invalidRegexes: string[];
    hotkeyOk?: boolean;
  }
  const api = (window as any).jevsnap as {
    getState(): Promise<State>;
    save(p: Settings): Promise<State>;
    setApiKey(k: string): Promise<State & { ok: boolean; persisted?: boolean; error?: string }>;
    pickFolder(): Promise<string | null>;
    openFolder(): Promise<void>;
    testConnection(): Promise<{ ok: boolean; message: string }>;
    openExternal(url: string): Promise<void>;
  };

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let state: State;

  // ---------- tabs ----------
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("nav button"));
  for (const b of tabs) {
    b.addEventListener("click", () => {
      for (const t of tabs) t.classList.toggle("active", t === b);
      for (const s of document.querySelectorAll<HTMLElement>("main > section")) s.hidden = s.id !== `tab-${b.dataset.tab}`;
    });
  }

  // ---------- generic bindings ----------
  const timers = new Map<string, number>();
  function saveSoon(key: string, value: unknown, delay = 0): void {
    window.clearTimeout(timers.get(key));
    timers.set(key, window.setTimeout(async () => {
      state = await api.save({ [key]: value });
      refreshDerived();
    }, delay));
  }

  function fmt(el: HTMLElement, v: number): string {
    return el.dataset.fmt === "pct" ? `${Math.round(v * 100)}%` : String(v);
  }

  function bindFields(): void {
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-key]")) {
      const key = el.dataset.key!;
      const v = state.settings[key];
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!v;
      else el.value = String(v ?? "");
      if (el.dataset.label) $(el.dataset.label).textContent = fmt(el, Number(v));
      if (el.dataset.bound) continue;
      el.dataset.bound = "1";
      el.addEventListener("input", () => {
        let value: unknown;
        if (el instanceof HTMLInputElement && el.type === "checkbox") value = el.checked;
        else if (el.dataset.type === "number") value = Number(el.value);
        else value = el.value;
        if (el.dataset.label) $(el.dataset.label).textContent = fmt(el, Number(value));
        saveSoon(key, value, el instanceof HTMLTextAreaElement || el.type === "text" ? 400 : 0);
      });
    }
  }

  function refreshDerived(): void {
    $("folderPath").textContent = state.settings.saveFolderPath;
    $("folderPath").title = state.settings.saveFolderPath;
    $("hotkeyLabel").textContent = prettyHotkey(state.settings.hotkey);
    $("regexMsg").textContent = state.invalidRegexes.length ? `Invalid pattern: ${state.invalidRegexes.join(", ")}` : "";
    const k = state.apiKey;
    $("keyInfo").textContent = k.stored
      ? (k.canPersist ? "A key is saved in your OS keystore." : "A key is held in memory for this session only.")
      : k.fromEnv ? "Using the TYPESAFE_API_KEY environment variable." : "No key saved.";
    if (!k.canPersist) {
      $("keyInfo").textContent += " No secure OS keystore was found (on Linux install gnome-keyring or KWallet), so the key is never written to disk; set TYPESAFE_API_KEY to avoid re-entering it.";
    }
    $("footer").textContent = `JEVsnap ${state.version} · ${state.platform}`;
  }

  // ---------- detectors ----------
  function renderDetectors(): void {
    const box = $("detectors");
    box.textContent = "";
    for (const d of state.detectors) {
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.settings.enabledDetectors.includes(d.kind);
      input.addEventListener("change", () => {
        const selected = state.detectors.filter((_d, i) => box.querySelectorAll<HTMLInputElement>("input")[i].checked).map((d) => d.kind);
        saveSoon("enabledDetectors", selected);
      });
      label.append(input, document.createTextNode(` ${d.title}`));
      box.append(label);
    }
  }

  // ---------- folder ----------
  $("pickFolder").addEventListener("click", async () => {
    const p = await api.pickFolder();
    if (p) { state = await api.save({ saveFolderPath: p }); refreshDerived(); }
  });
  $("openFolder").addEventListener("click", () => void api.openFolder());

  // ---------- hotkey recorder ----------
  const isMac = () => state.platform === "darwin";
  function prettyHotkey(acc: string): string {
    return acc.replace("CommandOrControl", isMac() ? "⌘" : "Ctrl").replace(/\+/g, " + ");
  }
  const KEY_NAMES: Record<string, string> = {
    Space: "Space", Enter: "Return", Tab: "Tab", Backspace: "Backspace", Minus: "-", Equal: "=", Comma: ",", Period: ".",
    Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backquote: "`",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", PrintScreen: "PrintScreen",
  };
  function acceleratorFrom(e: KeyboardEvent): string | null {
    let key: string | undefined;
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
    else key = KEY_NAMES[e.code];
    if (!key) return null;
    const mods: string[] = [];
    const primary = isMac() ? e.metaKey : e.ctrlKey;
    if (primary) mods.push("CommandOrControl");
    if (isMac() && e.ctrlKey) mods.push("Control");
    if (!isMac() && e.metaKey) mods.push("Super");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    const standalone = /^F\d{1,2}$/.test(key) || key === "PrintScreen";
    if (!standalone && !mods.some((m) => m !== "Shift")) return null;
    return [...mods, key].join("+");
  }

  let recording = false;
  const recBtn = $<HTMLButtonElement>("recordHotkey");
  function stopRecording(): void {
    recording = false;
    recBtn.classList.remove("recording");
    recBtn.textContent = "Record";
    window.removeEventListener("keydown", onKey, true);
  }
  async function onKey(e: KeyboardEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { stopRecording(); $("hotkeyMsg").textContent = ""; return; }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const acc = acceleratorFrom(e);
    if (!acc) { $("hotkeyMsg").textContent = "Use Ctrl/Alt with a key (or F1–F12)."; return; }
    stopRecording();
    await setHotkey(acc);
  }
  async function setHotkey(acc: string): Promise<void> {
    state = await api.save({ hotkey: acc });
    refreshDerived();
    $("hotkeyMsg").textContent = state.hotkeyOk === false ? "That shortcut is taken or not allowed on this system." : "";
    $("hotkeyMsg").classList.toggle("error", state.hotkeyOk === false);
  }
  recBtn.addEventListener("click", () => {
    if (recording) { stopRecording(); return; }
    recording = true;
    recBtn.classList.add("recording");
    recBtn.textContent = "Press shortcut…";
    $("hotkeyMsg").textContent = "Esc cancels.";
    window.addEventListener("keydown", onKey, true);
  });
  $("resetHotkey").addEventListener("click", () => void setHotkey(state.defaults.hotkey));

  // ---------- API key ----------
  $("saveKey").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("apiKey");
    const r = await api.setApiKey(input.value);
    input.value = "";
    state = r;
    refreshDerived();
    $("connMsg").className = r.ok ? "hint ok" : "hint error";
    $("connMsg").textContent = r.ok ? (r.persisted ? "Saved." : "Saved for this session.") : (r.error ?? "Could not save the key.");
  });
  $("removeKey").addEventListener("click", async () => {
    state = await api.setApiKey("");
    refreshDerived();
    $("connMsg").className = "hint";
    $("connMsg").textContent = "Key removed.";
  });
  $("testConn").addEventListener("click", async () => {
    $("connMsg").className = "hint";
    $("connMsg").textContent = "Testing…";
    const r = await api.testConnection();
    $("connMsg").className = r.ok ? "hint ok" : "hint error";
    $("connMsg").textContent = r.message;
  });
  $("consoleLink").addEventListener("click", (e) => { e.preventDefault(); void api.openExternal("https://console.typesafe.ai"); });

  // ---------- AI ----------
  $("resetRules").addEventListener("click", async () => {
    for (const key of ["aiHideRules", "aiKeepRules", "aiThreshold"]) window.clearTimeout(timers.get(key));
    state = await api.save({ aiHideRules: state.defaultRules.hide, aiKeepRules: state.defaultRules.keep, aiThreshold: state.defaults.aiThreshold });
    bindFields();
  });

  // ---------- boot ----------
  void api.getState().then((s) => {
    state = s;
    bindFields();
    renderDetectors();
    refreshDerived();
  });
})();
