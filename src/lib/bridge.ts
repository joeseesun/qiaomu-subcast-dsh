import manifest from "../../package.json";

const token = location.hash.slice(1);
export type UnlistenFn = () => void;

export async function invoke<T>(method: string, args: unknown = {}): Promise<T> {
  const response = await fetch("/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ method, args }),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || response.statusText);
  return result.value;
}

let events: EventSource | undefined;
export async function listen<T>(event: string, fn: (event: {payload: T}) => void): Promise<UnlistenFn> {
  events ??= new EventSource("/events?key=" + encodeURIComponent(token));
  const handler = (message: MessageEvent) => fn({ payload: JSON.parse(message.data) });
  events.addEventListener(event, handler);
  return () => events?.removeEventListener(event, handler);
}

export const getVersion = async () => manifest.version;
export const convertFileSrc = (file: string) =>
  "/media/" + encodeURIComponent(file.split(/[/\\]/).pop()!) + "?key=" + encodeURIComponent(token);
export async function openUrl(value: string) {
  const url = new URL(value);
  if (["http:", "https:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
}
export const getCurrentWindow = () => ({
  setFullscreen: async (on: boolean) => {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  },
  onFocusChanged: async (fn: (event: {payload: boolean}) => void) => {
    const focus = () => fn({payload: true});
    const blur = () => fn({payload: false});
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("blur", blur); };
  },
});
