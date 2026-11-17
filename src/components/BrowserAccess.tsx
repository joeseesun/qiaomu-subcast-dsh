// macOS keeps other apps' data private: before SubCast can read a browser's sign-in, the listener allows it once
// (system prompt, or Privacy & Security › Files and Folders). Shown when that was refused.
import { useEffect } from "react";
import { getCurrentWindow } from "../lib/bridge";
import { api } from "../lib/api";
import { t } from "../lib/i18n";

const NAMES: Record<string, string> = { chrome: "Chrome", safari: "Safari", edge: "Edge", firefox: "Firefox", brave: "Brave", chromium: "Chromium", opera: "Opera", vivaldi: "Vivaldi" };
export const browserName = (b: string) => NAMES[b] ?? b;

/** The explanation with a button to the right Settings page; `onRetry` runs again when the listener comes back. */
export function BrowserAccess({ browser, onRetry }: { browser: string; onRetry: () => void }) {
  const name = browserName(browser);
  // Back from System Settings: try again without another click.
  useEffect(() => {
    let armed = false;
    const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) armed = true;
      else if (armed) { armed = false; onRetry(); }
    });
    return () => { void off.then((f) => f()); };
  }, [browser]);
  return (
    <div className="browser-access">
      <p>{t("macOS 需要你允许 SubCast 读取 {name} 的数据，才能借用它的 YouTube 登录。", { name })}</p>
      <ol className="small">
        <li>{t("点下面的按钮打开「文件和文件夹」")}</li>
        <li>{t("找到 macOS 提示中的应用，打开「{name}」", { name })}</li>
        <li>{t("回到 SubCast，会自动重试")}</li>
      </ol>
      <div className="row-actions">
        <button className="btn primary sm" onClick={() => void api.openPrivacySettings()}>{t("打开系统设置")}</button>
        <button className="btn ghost sm" onClick={onRetry}>{t("重试")}</button>
      </div>
    </div>
  );
}
