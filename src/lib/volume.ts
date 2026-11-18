// Volume: one level for every player (audio, video, YouTube), kept on this computer. The slider is perceptual:
// hearing is logarithmic, so the gain is the slider position cubed (half way ≈ −18 dB, sounding about half as
// loud) instead of a linear gain that does almost nothing over the top half.
import { create } from "zustand";

const KEY = "subcast-volume";
interface Volume { level: number; muted: boolean }

function load(): Volume {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v.level === "number") return { level: Math.min(1, Math.max(0, v.level)), muted: !!v.muted };
  } catch { /* storage unavailable */ }
  return { level: 1, muted: false };
}

export const useVolume = create<Volume>(() => load());
useVolume.subscribe((s) => { try { localStorage.setItem(KEY, JSON.stringify({ level: s.level, muted: s.muted })); } catch { /* ignore */ } });

/** The gain a player should use, 0–1. */
export const gainOf = (s: Volume = useVolume.getState()) => (s.muted ? 0 : s.level ** 3);

/** Sets the slider position; dragging to zero is muting, dragging up from it unmutes. */
export function setLevel(level: number) {
  const l = Math.round(Math.min(1, Math.max(0, level)) * 100) / 100;
  useVolume.setState({ level: l, muted: l === 0 });
}

export function stepVolume(dir: 1 | -1): number {
  const s = useVolume.getState();
  setLevel((s.muted ? 0 : s.level) + dir * 0.1);
  return useVolume.getState().level;
}

/** Returns whether it is muted now. Unmuting at zero comes back at half. */
export function toggleMute(): boolean {
  const s = useVolume.getState();
  if (s.muted || s.level === 0) { useVolume.setState({ muted: false, level: s.level || 0.5 }); return false; }
  useVolume.setState({ muted: true });
  return true;
}

/** Keeps an <audio>/<video> at the current volume; returns the unsubscribe. */
export function followVolume(el: HTMLMediaElement) {
  const apply = () => { el.volume = gainOf(); el.muted = useVolume.getState().muted; };
  apply();
  return useVolume.subscribe(apply);
}
