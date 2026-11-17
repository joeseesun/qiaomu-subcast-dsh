import { sizeMb } from "../lib/format";
import { ask } from "../lib/confirm";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import { BookOpen, Check, ChevronDown, Cloud, Cpu, ExternalLink, FolderOpen, Github, Loader2, MessageCircle, RefreshCw, Trash2, X, Captions, HardDrive, Info, Keyboard, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import { getVersion } from "../lib/bridge";
import { ASR_SERVICES, CLOUD_ASR_MAIN } from "../lib/settings";
import { stopSpeaking } from "../lib/tts";
import logoUrl from "../assets/logo.png";
import wechatQr from "../assets/about-wechat-qr.jpg";
import rewardQr from "../assets/about-reward-qr.png";
import { openUrl } from "../lib/bridge";
import { api, errorText, llmChat, type CloudAsr, type ModelInfo, type Provider } from "../lib/api";
import { useStore } from "../store";
import { Modal } from "./Chrome";
import { bytes, clearDownloads, useOffline } from "../lib/offline";
import { HomeShowCard } from "./YtPromo";
import { useModelDownload } from "./TranscriptPanel";
import { LANGS, systemLang, t, tk, tr, type LangSetting, IS_MAC, kbd } from "../lib/i18n";
import { ModelSettings } from "./ModelSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { ReadingSettings } from "./ReadingSettings";

export const NO_AUTO = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/** One default model for translation and the guide; Q&A starts with it and can switch in the chat box. */
export function DefaultButton({ id, isDefault }: { id: string; isDefault: boolean }) {
  const saveSettings = useStore((s) => s.saveSettings);
  const mode = useStore((s) => s.settings.translateMode);
  return isDefault
    ? <p className="default-on small"><Check size={13} /> {t("当前默认模型")}</p>
    : <button className="btn primary sm" onClick={() => void saveSettings({ translateProvider: id, chatProvider: id, chatModel: "", modelChosen: true, ...(mode === "google" ? { translateMode: "auto" } : {}) })}>{t("设为默认模型")}</button>;
}

function ProviderEditor({ p, onChange }: { p: Provider; onChange: (p: Provider) => void }) {
  const settings = useStore((s) => s.settings);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [live, setLive] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setKey(""); setLive(null); setAdvanced(!p.needsKey); api.hasApiKey(p.id).then(setHasKey); }, [p.id]);
  const fetchModels = async () => {
    setFetching(true); setTesting(null); setTestOk(false);
    try { if (key.trim()) await saveKey(); const ids = await api.listModels(p); setLive(ids); if (!ids.length) setTesting(t("这个服务没有返回模型列表，请手动填写")); }
    catch (e) { setTesting(errorText(e)); } finally { setFetching(false); }
  };
  const saveKey = async () => { await api.setApiKey(p.id, key); setHasKey(!!key.trim()); setKey(""); };
  const test = async () => {
    setTesting("…"); setTestOk(false);
    try {
      if (key.trim()) await saveKey();
      const r = await llmChat({ provider: p, system: "Reply with one short word.", messages: [{ role: "user", content: "ping" }], maxTokens: 1500 });
      setTesting(t("可用 ✓ {reply}", { reply: r.slice(0, 20) })); setTestOk(true);
    } catch (e) { setTesting(errorText(e)); }
  };
  const forTranslate = settings.translateProvider === p.id && settings.translateMode !== "google";
  return (
    <div className="provider-form">
      {p.needsKey && (
        <div className="setup-block">
          <div className="setup-head">
            <p className="setup-title">API Key</p>
            {p.keyUrl && <button className="link-btn" onClick={() => openUrl(p.keyUrl!)}>{t("去官网申请")} <ExternalLink size={11} /></button>}
          </div>
          <KeyRow key={p.id} has={hasKey} value={key} onValue={setKey} onSave={saveKey} onDelete={async () => { await api.setApiKey(p.id, ""); setHasKey(false); }} />
        </div>
      )}
      <div className="setup-block">
        <DefaultButton id={p.id} isDefault={forTranslate} />
      </div>
      <div className="row-actions">
        <button className="btn sm" onClick={test} disabled={testing === "…"}>{testing === "…" && <Loader2 size={13} className="spin" />} {t("测试连接")}</button>
        {testing && testing !== "…" && <span className={testOk ? "ok-text small" : "error-text small"}>{testing}</span>}
        <span className="spacer" />
        <button className="adv-toggle" onClick={() => setAdvanced(!advanced)}><ChevronDown size={12} className={advanced ? "flip" : ""} /> {t("高级设置")}</button>
      </div>
      {advanced && (
        <div className="adv-body">
          <label><span>{t("接口类型")}</span>
            <select value={p.protocol} onChange={(e) => onChange({ ...p, protocol: e.target.value as Provider["protocol"] })}>
              <option value="openai">{t("OpenAI 兼容")}</option><option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label><span>{t("接口地址")}</span><input {...NO_AUTO} value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} placeholder="https://…/v1" /></label>
          <label><span>{t("模型")}</span>
            <input {...NO_AUTO} value={p.model} list={`models-${p.id}`} onChange={(e) => onChange({ ...p, model: e.target.value })} placeholder={t("模型名")} />
            <datalist id={`models-${p.id}`}>{[...new Set([...(live ?? []), ...(p.models ?? [])])].map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          {(p.models?.length || live?.length) ? (
            <div className="model-chips">
              {[...new Set([...(p.models ?? []), ...(live ?? []).slice(0, 40)])].map((m) => <button key={m} className={`chip sm ${p.model === m ? "on" : ""}`} onClick={() => onChange({ ...p, model: m })}>{m}</button>)}
            </div>
          ) : null}
          <div className="row-actions">
            <button className="btn ghost sm" onClick={fetchModels} disabled={fetching}>{fetching ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {t("获取模型列表")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const { settings, saveSettings, set, notify, settingsSection } = useStore(useShallow((s) => ({ settings: s.settings, saveSettings: s.saveSettings, set: s.set, notify: s.notify, settingsSection: s.settingsSection })));
  type Section = "subtitles" | "ai" | "general" | "about";
  // Old section names (links from elsewhere in the app) land in their new home.
  const LEGACY: Record<string, Section> = { overview: "subtitles", reading: "subtitles", asr: "subtitles", model: "ai", tts: "general", shortcuts: "general", storage: "general", general: "general", about: "about", subtitles: "subtitles", ai: "ai" };
  const [section, setSection] = useState<Section>(LEGACY[settingsSection ?? "subtitles"] ?? "subtitles");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [proxy, setProxy] = useState(settings.proxy);
  const [elsewhere, setElsewhere] = useState<{ app: string; format: string }[]>([]);
  const refresh = () => api.asrModels().then((m) => { setModels(m); void api.asrElsewhere().then((x) => setElsewhere(x ?? [])).catch(() => {}); });
  const { downloading, start, cancel } = useModelDownload(refresh);
  useEffect(() => { void refresh(); }, []);
  const [moreLocal, setMoreLocal] = useState(false);
  const [moreCloud, setMoreCloud] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const NAV: [Section, string, LucideIcon][] = [["subtitles", tk("字幕"), Captions], ["ai", tk("AI"), Sparkles], ["general", tk("通用"), SlidersHorizontal], ["about", tk("关于"), Info]];
  const modelRow = (m: ModelInfo) => (
    <div key={m.id} className={`model-item ${settings.asrEngine === "local" && settings.asrModel === m.id ? "on" : ""}`}>
      <div role="button" tabIndex={0} className="model-pick" onClick={() => saveSettings({ asrEngine: "local", asrModel: m.id })}>
        <span className={`radio ${settings.asrEngine === "local" && settings.asrModel === m.id ? "on" : ""}`} />
        <div><p>{tr(m.name)}</p><p className="muted small">{m.id.startsWith("file:") ? sizeMb(m.sizeMb) : [tr(m.note), sizeMb(m.sizeMb)].filter(Boolean).join(" · ")}</p></div>
      </div>
      {downloading?.id === m.id ? (
        <div className="dl"><span className="small">{downloading.total ? Math.round((downloading.received / downloading.total) * 100) : 0}%</span><button className="btn ghost sm" onClick={() => cancel(m.id)}>{t("取消")}</button></div>
      ) : m.installed && m.from ? (
        <div className="dl"><span className="from-tag small">{t("来自 {app}", { app: tr(m.from) })}</span><button className="icon-btn" title={t("不再使用（原文件保留）")} onClick={async () => { await api.deleteModel(m.id); void refresh(); }}><X size={14} /></button></div>
      ) : m.installed ? (
        <div className="dl"><span className="ok-text small"><Check size={13} /> {t("已下载")}</span><button className="icon-btn" title={t("删除模型")} onClick={async () => { await api.deleteModel(m.id); void refresh(); }}><Trash2 size={14} /></button></div>
      ) : (
        <button className="btn sm" onClick={() => start(m.id)} disabled={downloading != null}>{t("下载")}</button>
      )}
    </div>
  );

  return (
    <Modal title={t("设置")} onClose={() => { stopSpeaking(); set({ settingsOpen: false }); }} wide>
      <div className="settings">
        <nav className="settings-nav">
          {NAV.map(([k, label, Icon]) => <button key={k} className={section === k ? "on" : ""} onClick={() => setSection(k)}><Icon size={15} aria-hidden />{t(label)}</button>)}
        </nav>
        <div className="settings-body">
          {section === "subtitles" && (
            <>
              <ReadingSettings />
              <section className="setup-block">
                <p className="setup-title">{t("如果没有字幕时")}</p>
                <p className="muted small">{t("先查节目自带的和别人分享的字幕，都没有时才听写。")}</p>
                <div className="engine-switch">
                  <button className={`engine ${settings.asrEngine === "local" ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: "local" })}>
                    <Cpu size={18} /><div><p>{t("本机模型")}</p><p className="muted small">{t("免费，音频不出本机")}</p></div>
                  </button>
                  <button className={`engine ${settings.asrEngine !== "local" ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: settings.asrEngine !== "local" ? settings.asrEngine : "doubao" })}>
                    <Cloud size={18} /><div><p>{t("云端服务")}</p><p className="muted small">{t("更快，需要 Key，按量付费")}</p></div>
                  </button>
                </div>
                {settings.asrEngine === "local" ? (
                  <>
                    <div className="model-list">{models.filter((m) => m.id === "qwen3-asr").map(modelRow)}</div>
                    {elsewhere.length > 0 && !models.find((m) => m.id === "qwen3-asr")?.installed && (
                      <p className="model-elsewhere small">{t("在 {where} 里找到了 Qwen3-ASR，但它是 {format} 格式，SubCast 的识别程序只能用 GGUF 格式，没法直接共用。下载上面的 Qwen3-ASR（约 960 MB）只需一次。", { where: [...new Set(elsewhere.map((e) => tr(e.app)))].join("、"), format: [...new Set(elsewhere.map((e) => tr(e.format)))].join(" / ") })}</p>
                    )}
                    <button className="adv-toggle" aria-expanded={moreLocal} onClick={() => setMoreLocal(!moreLocal)}><ChevronDown size={12} className={moreLocal ? "flip" : ""} /> {t("其他模型")}</button>
                    {moreLocal && (
                      <>
                        <div className="model-list">{models.filter((m) => m.id !== "qwen3-asr").map(modelRow)}</div>
                        <button className="link-btn small" onClick={async () => { await api.rescanModels(); void refresh(); notify(t("已重新查找本机的识别模型")); }}><RefreshCw size={12} /> {t("重新查找本机已有的模型")}</button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div className="provider-tabs">
                      {ASR_SERVICES.filter((a) => moreCloud || CLOUD_ASR_MAIN.includes(a.id) || settings.asrEngine === a.id).map((a) => <button key={a.id} className={`chip ${settings.asrEngine === a.id ? "on" : ""}`} onClick={() => saveSettings({ asrEngine: a.id })}>{t(a.name)}</button>)}
                      {!moreCloud && <button className="chip" onClick={() => setMoreCloud(true)}>{t("更多")}</button>}
                    </div>
                    {settings.cloudAsr[settings.asrEngine] && <CloudAsrEditor key={settings.asrEngine} a={settings.cloudAsr[settings.asrEngine]} onChange={(na) => saveSettings({ cloudAsr: { ...settings.cloudAsr, [na.id]: na } }, true)} />}
                  </>
                )}
              </section>
            </>
          )}
          {section === "ai" && <ModelSettings ProviderEditor={ProviderEditor} />}
          {section === "general" && (
            <>
              <section className="setup-block">
                <p className="setup-title">{t("界面")}</p>
                <label><span>{t("界面语言")}</span>
                  <select value={settings.uiLang} onChange={(e) => void saveSettings({ uiLang: e.target.value as LangSetting })}>
                    <option value="auto">{t("跟随系统（{name}）", { name: LANGS.find((l) => l.id === systemLang())?.name ?? "" })}</option>
                    {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
                <label className="check"><input type="checkbox" checked={settings.youtubePromo} onChange={(e) => saveSettings({ youtubePromo: e.target.checked })} /> {t("显示节目的 YouTube 订阅按钮")}</label>
                {settings.youtubePromo && <label className="check"><input type="checkbox" checked={!settings.homeBannerHidden} onChange={(e) => saveSettings({ homeBannerHidden: !e.target.checked })} /> {t("在发现页顶部推荐「词元之外」")}</label>}
              </section>
              <section className="setup-block">
                <p className="setup-title">{t("订阅")}</p>
                <div className="row-actions">
                  <button className="btn sm" onClick={() => { set({ settingsOpen: false, addOpen: true, addTab: "import" }); }}>{t("导入订阅…")}</button>
                  <button className="btn sm" onClick={async () => { try { const path = await api.exportOpml(); notify(t("已导出到「下载」：{name}", { name: path.split(/[\\/]/).pop() ?? "" })); } catch (e) { notify(errorText(e)); } }}>{t("导出 OPML")}</button>
                </div>
              </section>
              <section className="setup-block">
                <p className="setup-title">{t("网络")}</p>
                <label><span>{t("代理")}</span>
                  <div className="key-row">
                    <input {...NO_AUTO} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder={t("留空就用系统代理")} />
                    <button className="btn sm" onClick={async () => { try { await saveSettings({ proxy }); notify(t("代理已保存")); } catch (e) { notify(errorText(e)); } }}>{t("保存")}</button>
                  </div>
                </label>
                <label><span>{t("YouTube 要求验证时")}</span>
                  <select value={settings.ytCookiesBrowser ?? ""} onChange={(e) => void saveSettings({ ytCookiesBrowser: e.target.value })}>
                    <option value="">{t("先问我")}</option>
                    {(IS_MAC ? ["chrome", "safari", "edge", "firefox", "brave"] : ["chrome", "edge", "firefox", "brave"]).map((b) => <option key={b} value={b}>{t("借用 {name} 的 YouTube 登录", { name: b[0].toUpperCase() + b.slice(1) })}</option>)}
                  </select>
                </label>
              </section>
              <section className="setup-block">
                <p className="setup-title">{t("共享")}</p>
                <label className="check"><input type="checkbox" checked={settings.shareTranscripts} onChange={(e) => saveSettings({ shareTranscripts: e.target.checked })} /> {t("匿名分享我生成的字幕、译文和导读")}</label>
                <p className="muted small">{t("只分享文字，帮别人省去等待。关掉后照样能用别人分享的。")}</p>
              </section>
              <section className="setup-block">
                <button className="setting-row" aria-expanded={showKeys} onClick={() => setShowKeys(!showKeys)}><Keyboard size={15} /> <span>{t("快捷键")}</span><span className="muted small">{t("{key} 随时查看", { key: kbd("⌘/") })}</span><ChevronDown size={14} className={showKeys ? "flip" : ""} /></button>
                {showKeys && <ShortcutSettings />}
                <button className="setting-row" aria-expanded={showStorage} onClick={() => setShowStorage(!showStorage)}><HardDrive size={15} /> <span>{t("存储")}</span><StorageTotal /><ChevronDown size={14} className={showStorage ? "flip" : ""} /></button>
                {showStorage && <Storage onAsr={() => setSection("subtitles")} />}
              </section>
            </>
          )}
          {section === "about" && <About />}
        </div>
      </div>
    </Modal>
  );
}

export function KeyField({ account, placeholder }: { account: string; placeholder?: string }) {
  const [key, setKey] = useState("");
  const [has, setHas] = useState(false);
  useEffect(() => { setKey(""); api.hasApiKey(account).then(setHas); }, [account]);
  return <KeyRow key={account} has={has} value={key} onValue={setKey} placeholder={placeholder}
    onSave={async () => { await api.setApiKey(account, key); setHas(!!key.trim()); setKey(""); }}
    onDelete={async () => { await api.setApiKey(account, ""); setHas(false); }} />;
}

/** A saved key reads as saved (a tinted row with a check and masked dots), not as an empty field;
 *  「更换」 opens the field again. */
function KeyRow({ has, value, onValue, onSave, onDelete, placeholder }: { has: boolean; value: string; onValue: (v: string) => void; onSave: () => Promise<void>; onDelete: () => Promise<void>; placeholder?: string }) {
  const [editing, setEditing] = useState(false);
  if (has && !editing) {
    return (
      <div className="key-row key-saved" title={t("存于系统钥匙串")}>
        <span className="key-state"><Check size={14} /><span>{t("已保存")}</span><span className="key-dots" aria-hidden>••••••••</span></span>
        <button className="btn sm" onClick={() => setEditing(true)}>{t("更换")}</button>
        <button className="icon-btn" title={t("删除 Key")} aria-label={t("删除 Key")} onClick={() => void onDelete()}><Trash2 size={14} /></button>
      </div>
    );
  }
  return (
    <div className="key-row">
      <input {...NO_AUTO} type="password" autoFocus={editing} value={value} onChange={(e) => onValue(e.target.value)} placeholder={placeholder ?? t("粘贴 API Key")} />
      <button className="btn sm" onClick={async () => { await onSave(); setEditing(false); }} disabled={!value.trim()}>{t("保存")}</button>
      {has && <button className="btn ghost sm" onClick={() => { onValue(""); setEditing(false); }}>{t("取消")}</button>}
    </div>
  );
}

function CloudAsrEditor({ a, onChange }: { a: CloudAsr; onChange: (a: CloudAsr) => void }) {
  return (
    <div className="provider-form">
      <p className="muted small">{t("{note}。识别时音频会发送到 {name}。", { note: t(a.note), name: t(a.name) })}</p>
      <label><span>{t("接口地址")}</span><input {...NO_AUTO} value={a.baseUrl} onChange={(e) => onChange({ ...a, baseUrl: e.target.value })} /></label>
      <label><span>{t("模型")}</span>
        <input {...NO_AUTO} value={a.model} list={`asr-${a.id}`} onChange={(e) => onChange({ ...a, model: e.target.value })} />
        <datalist id={`asr-${a.id}`}>{a.models.map((m) => <option key={m} value={m} />)}</datalist>
      </label>
      {a.models.length > 1 && <div className="model-chips">{a.models.map((m) => <button key={m} className={`chip sm ${a.model === m ? "on" : ""}`} onClick={() => onChange({ ...a, model: m })}>{m}</button>)}</div>}
      {a.needsKey && <label><span>API Key</span><KeyField account={`asr.${a.id}`} /></label>}
      {a.protocol === "deepseek" && <p className="muted small">{t("已在「AI 模型」里填过 DeepSeek Key 的话，这里可以留空。")}</p>}
      <div className="row-actions">
        <span className="spacer" />
        {a.keyUrl && <button className="btn ghost sm" onClick={() => openUrl(a.keyUrl!)}><ExternalLink size={13} /> {t("获取 Key")}</button>}
      </div>
    </div>
  );
}

const REPO = "https://github.com/joeseesun/subcast";
/** "占用 1.9 GB" for the 通用 page's storage row. */
function StorageTotal() {
  const [total, setTotal] = useState<number | null>(null);
  useEffect(() => { void api.storageInfo().then((i) => setTotal(i.downloads + i.models + i.library + i.temp)).catch(() => {}); }, []);
  return <span className="muted small">{total == null ? "" : t("占用 {size}", { size: bytes(total) })}</span>;
}

function Storage({ onAsr }: { onAsr: () => void }) {
  const { set, go } = useStore(useShallow((s) => ({ set: s.set, go: s.go })));
  const saved = useOffline((s) => s.saved);
  const [info, setInfo] = useState<{ downloads: number; models: number; library: number; temp: number } | null>(null);
  const load = () => void api.storageInfo().then(setInfo).catch(() => {});
  useEffect(load, [saved]);
  const n = Object.keys(saved).length;
  const size = (b?: number) => (info ? (b ? bytes(b) : "0 MB") : "…");
  const clearAll = async () => {
    if (!(await ask({ title: t("删除全部已下载的音频？"), message: t("字幕、精读和收听进度都会保留。"), ok: t("全部删除"), danger: true }))) return;
    await clearDownloads(); load();
  };
  return (
    <>
      <div className="storage-list">
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("离线下载")}</p>
            <p className="muted small">{n ? t("{n} 集音频，没有网络也能听", { n }) : t("在单集页点下载按钮，就能离线收听")}</p>
          </div>
          <span className="storage-size">{size(info?.downloads)}</span>
          <button className="btn sm" onClick={() => void api.openDataFolder("downloads")}><FolderOpen size={13} /> {t("打开文件夹")}</button>
          {n > 0 && <button className="btn ghost sm" onClick={() => { set({ settingsOpen: false }); go({ kind: "downloads" }); }}>{t("查看")}</button>}
          {n > 0 && <button className="icon-btn" title={t("全部删除")} onClick={clearAll}><Trash2 size={14} /></button>}
        </div>
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("语音识别模型")}</p>
            <p className="muted small">{t("本机识别用的模型，在「语音识别」里下载或删除")}</p>
          </div>
          <span className="storage-size">{size(info?.models)}</span>
          <button className="btn sm" onClick={() => void api.openDataFolder("models")}><FolderOpen size={13} /> {t("打开文件夹")}</button>
          <button className="btn ghost sm" onClick={onAsr}>{t("管理")}</button>
        </div>
        <div className="storage-row">
          <div className="storage-row-text">
            <p className="storage-row-name">{t("节目库")}</p>
            <p className="muted small">{t("订阅、字幕、翻译、精读和收听进度")}</p>
          </div>
          <span className="storage-size">{size(info?.library)}</span>
          <button className="btn ghost sm" onClick={() => void api.openDataFolder("data")}><FolderOpen size={13} /> {t("打开文件夹")}</button>
        </div>
        {!!info?.temp && (
          <div className="storage-row">
            <div className="storage-row-text">
              <p className="storage-row-name">{t("临时文件")}</p>
              <p className="muted small">{t("中断的识别留下的音频，可以放心清理")}</p>
            </div>
            <span className="storage-size">{size(info.temp)}</span>
            <button className="btn sm" onClick={() => void api.clearTemp().then(load)}>{t("清理")}</button>
          </div>
        )}
      </div>
    </>
  );
}

function About() {
  const [version, setVersion] = useState("0.1.0");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  const links: [string, string][] = [["qiaomu.ai", "https://qiaomu.ai"], [t("博客"), "https://blog.qiaomu.ai"], [t("乔木推荐"), "https://tuijian.qiaomu.ai"], ["X", "https://x.com/vista8"], ["GitHub", "https://github.com/joeseesun"]];
  return (
    <div className="about">
      <div className="about-top">
        <img src={logoUrl} alt="" />
        <div className="about-meta">
          <p className="about-name">SubCast <span className="about-ver">{t("版本 {version}", { version })}</span></p>
          <p className="muted small">{t("海外好播客，配上中文字幕、精读与 AI 问答。")}</p>
          <p className="muted small">{t("插件更新由 DSH 管理")}</p>
        </div>
      </div>
      <div className="row-actions">
        <button className="btn sm" onClick={() => openUrl(`${REPO}/issues/new`)}><MessageCircle size={13} /> {t("反馈问题")}</button>
        <button className="btn sm" onClick={() => openUrl(`${REPO}#readme`)}><BookOpen size={13} /> {t("使用说明")}</button>
        <button className="btn sm" onClick={() => openUrl(REPO)}><Github size={13} /> {t("源代码")}</button>
      </div>
      <HomeShowCard />
      <div className="about-qr">
        <div className="qr-card"><img src={wechatQr} alt={t("公众号二维码")} /><div><p className="qr-title">{t("关注公众号")}</p><p className="muted small">{t("微信搜索「向阳乔木推荐看」")}</p></div></div>
        <div className="qr-card"><img src={rewardQr} alt={t("赞赏码")} /><div><p className="qr-title">{t("请我喝杯咖啡")}</p><p className="muted small">{t("微信扫码赞赏")}</p></div></div>
      </div>
      <div className="about-foot">
        {links.map(([label, u]) => <button key={u} className="link-btn" onClick={() => openUrl(u)}>{label}</button>)}
        <span className="spacer" />
        <span className="muted small">{t("© {year} 向阳乔木 · AGPL-3.0", { year: new Date().getFullYear() })}</span>
      </div>
    </div>
  );
}
