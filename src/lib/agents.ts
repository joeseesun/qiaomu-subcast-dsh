// Local AI agents (Claude Code, Codex, Qwen Code, Kimi Code, OpenCode, Gemini CLI) found on this computer, and
// the rule that puts one to work when nothing else is set up. The Rust side (agents.rs) runs them.
import { create } from "zustand";
import { invoke } from "./bridge";
import type { Provider } from "./api";
import { useStore } from "../store";
import { tk } from "./i18n";

export type AgentKind = "claude" | "codex" | "antigravity" | "gemini" | "qwen" | "kimi" | "opencode";
export interface FoundAgent { kind: AgentKind; path: string; version: string; login: "ready" | "needsLogin" | "unknown" }

export const AGENTS: Record<AgentKind, { name: string; vendor: string; login: string; plan: string; models: string[]; install: string }> = {
  claude: { name: "Claude Code", vendor: "Anthropic", login: "claude", plan: tk("Claude 订阅（Pro / Max）"), models: ["sonnet", "opus", "haiku"], install: "https://claude.com/claude-code" },
  codex: { name: "Codex", vendor: "OpenAI", login: "codex login", plan: tk("ChatGPT 订阅"), models: [], install: "https://developers.openai.com/codex/cli" },
  antigravity: { name: "Antigravity CLI", vendor: "Google", login: "agy", plan: tk("Google 账号（Gemini）"), models: ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-3.8-flash-low"], install: "https://antigravity.google" },
  qwen: { name: "Qwen Code", vendor: tk("阿里通义"), login: "qwen", plan: tk("通义账号"), models: [], install: "https://github.com/QwenLM/qwen-code" },
  kimi: { name: "Kimi Code", vendor: tk("月之暗面"), login: "kimi", plan: tk("Kimi 账号"), models: [], install: "https://www.kimi.com/code" },
  opencode: { name: "OpenCode", vendor: "OpenCode", login: "opencode auth login", plan: tk("OpenCode 里登录的服务"), models: [], install: "https://opencode.ai" },
  gemini: { name: "Gemini CLI", vendor: "Google", login: "gemini", plan: tk("Gemini API Key 或企业版账号"), models: [], install: "https://github.com/google-gemini/gemini-cli" },
};
/** Which one to use first when several are logged in: fastest and steadiest for this job first (measured). */
const PREFERENCE: AgentKind[] = ["claude", "antigravity", "qwen", "codex", "kimi", "opencode", "gemini"];

export const agentProviderId = (k: AgentKind) => `cli-${k}`;
export const agentOf = (p?: Provider | null): AgentKind | null => (p?.protocol === "cli" ? (p.id.replace(/^cli-/, "") as AgentKind) : null);

export function agentProvider(k: AgentKind): Provider {
  return { id: agentProviderId(k), name: AGENTS[k].name, group: "cli", protocol: "cli", baseUrl: "local", model: "", needsKey: false, models: AGENTS[k].models };
}

interface AgentsState { found: FoundAgent[] | null; checking: boolean }
export const useAgents = create<AgentsState>(() => ({ found: null, checking: false }));

/** Looks for agents again (on start, opening settings, 重新检测), then applies the auto-use rule. */
export async function detectAgents() {
  if (useAgents.getState().checking) return;
  useAgents.setState({ checking: true });
  try {
    const found = await invoke<FoundAgent[]>("local_agents");
    found.sort((a, b) => PREFERENCE.indexOf(a.kind) - PREFERENCE.indexOf(b.kind));
    useAgents.setState({ found });
    await adopt(found);
  } catch { useAgents.setState({ found: [] }); }
  finally { useAgents.setState({ checking: false }); }
}

/** Has the listener a model of their own set up (a saved key, a local server they chose, or an agent)? */
async function hasOwnModel(): Promise<boolean> {
  const s = useStore.getState().settings;
  const p = s.providers[s.chatProvider];
  if (!p) return false;
  if (p.protocol === "cli" || p.protocol === "dsh") return true;
  if (!p.needsKey) return p.group === "local" && s.modelChosen === true;
  return invoke<boolean>("has_api_key", { provider: p.id }).catch(() => false);
}

/** When nothing is set up and the listener hasn't chosen, a logged-in agent answers questions and translates.
 *  A choice the listener made is never overridden; an agent that isn't logged in is never picked. */
async function adopt(found: FoundAgent[]) {
  const { settings, saveSettings } = useStore.getState();
  const providers = { ...settings.providers };
  let changed = false;
  for (const f of found) if (!providers[agentProviderId(f.kind)]) { providers[agentProviderId(f.kind)] = agentProvider(f.kind); changed = true; }
  const pick = found.find((f) => f.login === "ready");
  const adoptIt = pick && !settings.modelChosen && !(await hasOwnModel());
  if (adoptIt) {
    const id = agentProviderId(pick!.kind);
    await saveSettings({ providers, chatProvider: id, chatModel: "", translateProvider: id, autoPicked: id });
  } else if (changed) await saveSettings({ providers });
}

/** Starts the agent behind a provider in the background, so the first answer is quicker. */
export function warmAgent(p?: Provider | null) {
  const k = agentOf(p);
  if (k) void invoke("warm_agent", { kind: k }).catch(() => {});
}
