import { create } from "zustand";
import { api, type Episode, type Show } from "./lib/api";
import { DEFAULTS, loadSettings, type Settings } from "./lib/settings";
import { setLang, t } from "./lib/i18n";

export type View =
  | { kind: "latest" }
  | { kind: "recent" }
  | { kind: "stats" }
  | { kind: "discover" }
  | { kind: "downloads" }
  | { kind: "show"; id: string }
  | { kind: "channel"; input: string }
  | { kind: "episode"; id: string };

export interface PlayerHandle {
  seek(seconds: number): void;
  toggle(): void;
  play(): void;
  setRate(rate: number): void;
  /** The episode this player plays. A video's player can be ready before the episode becomes current. */
  episodeId?: string;
}

interface State {
  speaking: boolean;
  ready: boolean;
  settings: Settings;
  shows: Show[];
  view: View;
  history: View[];
  /** The episode loaded in the player (may differ from the one being viewed). */
  current: Episode | null;
  time: number;
  length: number;
  playing: boolean;
  player: PlayerHandle | null;
  /** Since when playback has been asked for but no sound has come yet (connecting, buffering); null when not waiting. */
  loadingSince?: number | null;
  /** Play as soon as the player for `current` is ready (it may take a few seconds to appear). */
  playWhenReady?: string | null;
  /** Seek here as soon as this episode's player appears. */
  seekWhenReady?: { id: string; at: number } | null;
  /** First run: show the welcome card; shows are being subscribed in the background. */
  welcome?: boolean;
  settingUp?: boolean;
  /** The video fills the window (and the window the screen), subtitles on it. */
  theater?: boolean;
  /** Which tab the add dialog opens on. */
  addTab?: "search" | "link" | "import";
  toast: string | null;
  settingsOpen: boolean;
  settingsSection?: "model" | "asr" | "reading" | "tts" | "shortcuts" | "general" | "storage" | "about";
  addOpen: boolean;
  init(): Promise<void>;
  go(view: View): void;
  back(): void;
  reloadShows(): Promise<void>;
  /** `lazy`: for text being typed. The change shows at once; the disk write waits until typing pauses. */
  saveSettings(patch: Partial<Settings>, lazy?: boolean): Promise<void>;
  openEpisode(ep: Episode): void;
  /** Loads an episode into the player without navigating. */
  load(ep: Episode): void;
  notify(text: string): void;
  openSettings(section?: "model" | "asr" | "tts" | "general" | "storage" | "about"): void;
  /** Checks every subscription for new episodes; tells the user when there are some. */
  checkUpdates(): Promise<void>;
  lastChecked: number;
  set(patch: Partial<State>): void;
}

const CHECK_EVERY = 30 * 60_000;

let toastTimer: number | undefined;

export const useStore = create<State>((set, get) => ({
  ready: false,
  speaking: false,
  settings: DEFAULTS,
  shows: [],
  view: { kind: "latest" },
  history: [],
  current: null,
  time: 0,
  length: 0,
  playing: false,
  player: null,
  toast: null,
  settingsOpen: false,
  addOpen: false,
  async init() {
    const [settings, shows] = await Promise.all([loadSettings(), api.listShows()]);
    setLang(settings.uiLang);

    set({ settings, shows, ready: true });
    void get().checkUpdates();
    // Periodically, and when the window comes back after a while (the app may sit in the background for hours).
    window.setInterval(() => void get().checkUpdates(), CHECK_EVERY);
    window.addEventListener("focus", () => { if (Date.now() - get().lastChecked > 10 * 60_000) void get().checkUpdates(); });
  },
  lastChecked: 0,
  async checkUpdates() {
    if (!get().shows.some((s) => s.kind !== "single")) return;
    set({ lastChecked: Date.now() });
    try {
      const r = await api.refreshAll();
      if (r.skipped) return;
      await get().reloadShows();
      if (r.newEpisodes > 0) get().notify(t("订阅有 {n} 期新节目", { n: r.newEpisodes }));
    } catch { /* offline: try again next time */ }
  },
  go(view) {
    set((s) => ({ view, history: [...s.history.slice(-30), s.view] }));
  },
  back() {
    const h = get().history;
    if (h.length) set({ view: h[h.length - 1], history: h.slice(0, -1) });
    else set({ view: { kind: "latest" } });
  },
  async reloadShows() {
    // Unchanged after a refresh (the usual case): keep the same array, so pages that depend on it don't reload.
    const shows = await api.listShows();
    if (JSON.stringify(shows) !== JSON.stringify(get().shows)) set({ shows });
  },
  async saveSettings(patch, lazy) {
    const settings = { ...get().settings, ...patch };
    if (patch.uiLang) { setLang(patch.uiLang); }
    set({ settings });
    window.clearTimeout(settingsTimer);
    settingsTimer = 0;
    if (lazy) { settingsTimer = window.setTimeout(() => { settingsTimer = 0; void api.setSettings(get().settings); }, 400); return; }
    await api.setSettings(settings);
  },
  openEpisode(ep) {
    // The episode page decides whether to load it into the player (it leaves a playing episode alone).
    get().go({ kind: "episode", id: ep.id });
  },
  load(ep) {
    // Keep a player that already belongs to this episode (a video ready before "play" was pressed).
    if (get().current?.id !== ep.id) { const p = get().player; set({ current: ep, time: ep.progress || 0, length: ep.duration || 0, playing: false, player: p?.episodeId === ep.id ? p : standby.get(ep.id) ?? null }); }
  },
  notify(text) {
    set({ toast: text });
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 4200);
  },
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section }),
  set: (patch) => set(patch),
}));

/** Players that exist for an episode that isn't the current one (a video page opened while something else plays).
 *  Only the current episode's player drives the global controls; another becomes current when it is loaded. */
const standby = new Map<string, PlayerHandle>();

/** A player is ready for its episode: it takes the controls if that episode is current, else waits here. */
export function offerPlayer(h: PlayerHandle & { episodeId: string }, extra?: Partial<State>) {
  standby.set(h.episodeId, h);
  const s = useStore.getState();
  if (s.current?.id === h.episodeId) s.set({ player: h, ...extra });
}

/** A player is going away: it stops being offered, and leaves the controls if it had them. */
export function withdrawPlayer(h: PlayerHandle & { episodeId: string }) {
  if (standby.get(h.episodeId) === h) standby.delete(h.episodeId);
  const s = useStore.getState();
  if (s.player === h) s.set({ player: null, playing: false });
}

/** Seeks once the current episode's player exists (a video's player takes a moment to appear). */
export function seekSoon(seconds: number) {
  const s = useStore.getState();
  if (s.player) { s.player.seek(seconds); return; }
  if (s.current) s.set({ time: seconds, seekWhenReady: { id: s.current.id, at: seconds } });
}

let settingsTimer = 0;
// A typed setting still waiting is written as soon as the window loses focus or hides (⌘Q may not give
// the page a chance to unload).
const flushSettings = () => { if (settingsTimer) { window.clearTimeout(settingsTimer); settingsTimer = 0; void api.setSettings(useStore.getState().settings); } };
window.addEventListener("blur", flushSettings);
document.addEventListener("visibilitychange", flushSettings);
window.addEventListener("beforeunload", flushSettings);

export function providerFor(settings: Settings, use: "chat" | "translate") {
  if (use === "translate") return settings.providers[settings.translateProvider];
  const p = settings.providers[settings.chatProvider];
  if (p?.protocol === "dsh") {
    const preference = settings.chatDshModel;
    if (preference === "host-default") return p;
    const chosen = preference ?? settings.dshAccountDefault;
    return { ...p, preferDshAccount: preference == null, ...(chosen && { name: chosen.providerName, model: chosen.model, dshModel: chosen }) };
  }
  return p && settings.chatModel ? { ...p, model: settings.chatModel } : p;
}
