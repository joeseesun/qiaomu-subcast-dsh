// Loads YouTube's IFrame Player API once.
import { t } from "./i18n";

declare global {
  interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void }
}

let loading: Promise<any> | null = null;

export function loadYouTube(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    const fail = () => { window.clearTimeout(timer); loading = null; script.remove(); reject(new Error(t("无法加载 YouTube 播放器，请检查网络或代理"))); };
    script.onerror = fail;
    // Without a route to youtube.com the script can hang instead of failing: give up after 12 s.
    const timer = window.setTimeout(() => { if (!window.YT?.Player) fail(); }, 12000);
    window.onYouTubeIframeAPIReady = () => { window.clearTimeout(timer); previous?.(); resolve(window.YT); };
    document.head.appendChild(script);
  });
  return loading;
}
