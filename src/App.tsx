import { ConfirmHost } from "./components/ConfirmHost";
import { useShallow } from "zustand/react/shallow";
import { Splitter } from "./components/Splitter";
import { SelectionTools } from "./components/SelectionTools";
import { SIDEBAR, useLayout } from "./lib/layout";
import { lazy, memo, Suspense, useEffect } from "react";
// Loaded when first opened, not with the app.
const StatsView = lazy(() => import("./components/StatsView").then((m) => ({ default: m.StatsView })));
import type { View } from "./store";
import { listen } from "./lib/bridge";
import { api } from "./lib/api";
import { detectAgents } from "./lib/agents";
import { useReadingSettings } from "./lib/reading";
import { useRevealOnExpand } from "./lib/reveal";
import { startJobListeners } from "./lib/jobs";
import { useStore } from "./store";
import { AddDialog, MiniPlayer, Sidebar, Toast, TopBar } from "./components/Chrome";
import { DiscoverView, DownloadsView, LatestView, RecentView, ShowView, ChannelView, firstRunSetup } from "./components/Lists";
import { startOffline } from "./lib/offline";
import { loadFavorites } from "./lib/library";
import { EpisodeView } from "./components/EpisodeView";
import { VideoDock } from "./components/VideoDock";
import { AudioEngine, cycleMode, noteListening, stepRate, toggleTheater } from "./components/Players";
import { actionFor, comboOf, isPlain, useKeysHelp, type ActionId } from "./lib/shortcuts";
import { useJobs } from "./lib/jobs";
import { activeIndex } from "./components/TranscriptPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { stepVolume, toggleMute } from "./lib/volume";
import { KeysHelp } from "./components/ShortcutSettings";
import { t, useLang } from "./lib/i18n";
import { EqBars } from "./components/Illustrations";

export default function App() {
  useReadingSettings();
  useRevealOnExpand();
  const { ready, view, settingsOpen, addOpen, init } = useStore(useShallow((s) => ({ ready: s.ready, view: s.view, settingsOpen: s.settingsOpen, addOpen: s.addOpen, init: s.init })));

  useEffect(() => {
    startJobListeners();
    void startOffline();
    void loadFavorites();
    void api.refreshConfig().catch(() => {});
    // Listening time is flushed when playback stops, not only every 20 s.
    const offPlaying = useStore.subscribe((s, prev) => { if (prev.playing && !s.playing && s.current) noteListening(s.current, false); });
    window.addEventListener("beforeunload", () => { const c = useStore.getState().current; if (c) noteListening(c, false); });
    // Local AI agents (Claude Code and the like): found once settings are loaded, put to work if nothing else is set up.
    void init().then(() => { void firstRunSetup(); void detectAgents(); });
    // Shortcuts come from one registry (lib/shortcuts.ts), so Settings › 快捷键 can change them.
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (!combo) return;
      const { settings } = useStore.getState();
      const action = actionFor(combo, settings.shortcuts);
      if (!action) return;
      const typing = (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable], [role=separator], .shortcut-recorder");
      // Text boxes keep their own keys: plain ones, and arrows with modifiers (⌘↑ jumps to the top).
      if (typing && (isPlain(combo) || combo.includes("Arrow"))) return;
      if (document.querySelector(".shortcut-recorder.recording")) return;
      const { player, time, current } = useStore.getState();
      const segs = current ? useJobs.getState().transcripts[current.id]?.segments : undefined;
      const lineSeek = (dir: -1 | 1) => {
        if (!segs?.length) return false;
        const i = activeIndex(segs, time);
        const j = Math.min(segs.length - 1, Math.max(0, dir < 0 ? (time - (segs[i]?.start ?? 0) > 2 ? i : i - 1) : i + 1));
        player?.seek(segs[j].start);
        return true;
      };
      const run: Record<ActionId, () => boolean | void> = {
        playPause: () => player?.toggle(),
        back: () => player?.seek(Math.max(0, time - (settings.skipBack ?? 15))),
        forward: () => player?.seek(time + (settings.skipForward ?? 30)),
        backShort: () => player?.seek(Math.max(0, time - 5)),
        forwardShort: () => player?.seek(time + 5),
        prevLine: () => lineSeek(-1),
        nextLine: () => lineSeek(1),
        speedUp: () => stepRate(1),
        speedDown: () => stepRate(-1),
        mute: () => { useStore.getState().notify(toggleMute() ? t("已静音") : t("已取消静音")); },
        volumeUp: () => { useStore.getState().notify(t("音量 {n}%", { n: Math.round(stepVolume(1) * 100) })); },
        volumeDown: () => { useStore.getState().notify(t("音量 {n}%", { n: Math.round(stepVolume(-1) * 100) })); },
        fullscreen: () => toggleTheater(),
        subtitleMode: () => cycleMode(),
        toggleSidebar: () => { const l = useLayout.getState(); l.put({ sideOpen: !l.sideOpen }); },
        togglePanel: () => { const l = useLayout.getState(); l.put({ panelOpen: !l.panelOpen }); },
        search: () => { const box = document.querySelector<HTMLInputElement>(".top-search input"); if (!box) return false; box.focus(); box.select(); },
        settings: () => useStore.getState().openSettings(),
        keysHelp: () => useKeysHelp.setState((s) => ({ open: !s.open })),
      };
      if (run[action]() !== false) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    const scrollTimers = new WeakMap<Element, number>();
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      el.classList.add("is-scrolling");
      window.clearTimeout(scrollTimers.get(el));
      scrollTimers.set(el, window.setTimeout(() => el.classList.remove("is-scrolling"), 900));
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    // The first time our subtitles help someone else, say so once (and where to turn it off).
    const offShared = listen("shared-upload", () => {
      if (localStorage.getItem("sharedNoticeShown")) return;
      localStorage.setItem("sharedNoticeShown", "1");
      useStore.getState().notify(t("你的字幕已匿名分享给其他听友（设置 › 通用 可关闭）"));
    });
    return () => { offPlaying(); window.removeEventListener("keydown", onKey); document.removeEventListener("scroll", onScroll, { capture: true }); void offShared.then((f) => f()); };
  }, []);

  const { sidebar, sideOpen, put: putLayout } = useLayout(useShallow((l) => ({ sidebar: l.sidebar, sideOpen: l.sideOpen, put: l.put })));
  const keysHelp = useKeysHelp((s) => s.open);
  const lang = useLang((s) => s.lang); // re-render the tree when the interface language changes
  if (!ready) return <div className="boot" role="status" aria-label={t("正在启动")}><EqBars /></div>;
  return (
    <div className={`app ${sideOpen ? "" : "side-collapsed"}`} style={{ "--sidebar-w": `${sideOpen ? sidebar : 72}px` } as React.CSSProperties}>
      <Sidebar />
      <Splitter value={sideOpen ? sidebar : 72} min={SIDEBAR.min} max={SIDEBAR.max} def={SIDEBAR.def} snap={SIDEBAR.snap} edge="right" label={t("侧栏宽度")} onChange={(w) => putLayout({ sidebar: w, sideOpen: true })} onCollapse={() => putLayout({ sideOpen: false })} />
      <Main view={view} lang={lang} />
      <MiniPlayer />
      <AudioEngine />
      <VideoDock />
      {settingsOpen && <SettingsDialog />}
      {keysHelp && <KeysHelp />}
      {addOpen && <AddDialog />}
      <SelectionTools />
      <ConfirmHost />
      <Toast />
    </div>
  );
}

/** The page itself, memoised: dragging the sidebar or opening a dialog re-renders App, not the page under it. */
// `lang` is passed so a language change still reaches the page.
const Main = memo(function Main({ view }: { view: View; lang: string }) {
  return (
    <main className="main">
      {view.kind !== "episode" && <TopBar />}
      {view.kind === "latest" && <LatestView />}
      {view.kind === "recent" && <RecentView />}
      {view.kind === "stats" && <Suspense fallback={null}><StatsView /></Suspense>}
      {view.kind === "discover" && <DiscoverView />}
      {view.kind === "downloads" && <DownloadsView />}
      {view.kind === "show" && <ShowView key={view.id} id={view.id} />}
      {view.kind === "channel" && <ChannelView key={view.input} input={view.input} />}
      {view.kind === "episode" && <EpisodeView key={view.id} id={view.id} />}
    </main>
  );
});
