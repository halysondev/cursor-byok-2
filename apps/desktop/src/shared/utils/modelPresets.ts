import type { ModelType } from "../api";
import deepseekIcon from "../assets/provider-icons/deepseek.svg";
import huoshanIcon from "../assets/provider-icons/huoshan.png";
import kimiIcon from "../assets/provider-icons/kimi.svg";
import minimaxIcon from "../assets/provider-icons/minimax.svg";
import zhipuIcon from "../assets/provider-icons/zhipu.svg";
import { defaultCustomHeaders } from "./modelDefaults";

export interface ModelPresetEntry {
  model_id: string;
  display_name: string;
  context_window_tokens: number | null;
  max_output_tokens: number | null;
}

/** A provider's connection endpoint for one protocol (anthropic / openai). */
export interface ModelPresetEndpoint {
  baseUrl: string;
  /** When true, baseUrl is the complete request URL; when false, the protocol appends its standard endpoint path. */
  useFullUrl: boolean;
  /** Request endpoint for the openai protocol (ignored when useFullUrl is true). */
  openaiEndpoint: string;
  /** When non-empty, enables custom headers (claude-cli impersonation headers). */
  customHeaders: Record<string, string> | null;
}

export interface ModelPreset {
  key: string;
  name: string;
  icon: string;
  keyHint: string;
  /** All five providers offer both Anthropic- and OpenAI-compatible protocols. */
  endpoints: { anthropic: ModelPresetEndpoint; openai: ModelPresetEndpoint };
  models: ModelPresetEntry[];
}

const entry = (
  modelId: string,
  displayName: string,
  contextWindowTokens: number | null,
  maxOutputTokens: number | null,
): ModelPresetEntry => ({
  model_id: modelId,
  display_name: displayName,
  context_window_tokens: contextWindowTokens,
  max_output_tokens: maxOutputTokens,
});

const claudeHeaders = { ...defaultCustomHeaders };
/** anthropic protocol: enter the Base URL, /v1/messages is appended automatically. */
const anthropic = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, useFullUrl: false, openaiEndpoint: "", customHeaders: claudeHeaders });
/** openai protocol: enter the Base URL, /v1/chat/completions is appended automatically. */
const openaiChat = (baseUrl: string): ModelPresetEndpoint => ({ baseUrl, useFullUrl: false, openaiEndpoint: "/v1/chat/completions", customHeaders: null });
/** openai protocol: the path is non-standard, so the full request URL is given directly. */
const openaiFullUrl = (url: string): ModelPresetEndpoint => ({ baseUrl: url, useFullUrl: true, openaiEndpoint: "/v1/chat/completions", customHeaders: null });

export const modelPresets: ModelPreset[] = [
  {
    key: "zhipu",
    name: "Zhipu GLM",
    icon: zhipuIcon,
    keyHint: "bigmodel.cn → GLM Coding Plan → API Key (plan keys and regular keys are not interchangeable)",
    endpoints: {
      anthropic: anthropic("https://open.bigmodel.cn/api/anthropic"),
      openai: openaiFullUrl("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"),
    },
    models: [
      entry("glm-5.3", "GLM 5.3", 1000000, 65536),
      entry("glm-5.2", "GLM 5.2", 200000, 32768),
      entry("glm-4.7", "GLM 4.7", 200000, 32768),
    ],
  },
  {
    key: "kimi",
    name: "Kimi (Moonshot)",
    icon: kimiIcon,
    keyHint: "Get an API key from the Kimi Code coding plan page (api.kimi.com/coding endpoint)",
    endpoints: {
      anthropic: anthropic("https://api.kimi.com/coding"),
      openai: openaiChat("https://api.kimi.com/coding"),
    },
    models: [
      entry("k3", "Kimi K3", 1048576, 65536),
      entry("kimi-for-coding", "K2.7 Coding", 262144, 32768),
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    icon: deepseekIcon,
    keyHint: "platform.deepseek.com → API Keys",
    endpoints: {
      anthropic: anthropic("https://api.deepseek.com/anthropic"),
      openai: openaiChat("https://api.deepseek.com"),
    },
    models: [
      entry("deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 65536),
      entry("deepseek-v4-flash", "DeepSeek V4 Flash", 1000000, null),
    ],
  },
  {
    key: "volcengine",
    name: "Volcano Engine Ark",
    icon: huoshanIcon,
    keyHint: "Volcano Ark Coding Plan (ark-code-latest routes to multiple coding models)",
    endpoints: {
      anthropic: anthropic("https://ark.cn-beijing.volces.com/api/coding"),
      openai: openaiFullUrl("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"),
    },
    models: [entry("ark-code-latest", "Ark Code Latest", 256000, 32768)],
  },
  {
    key: "minimax",
    name: "MiniMax",
    icon: minimaxIcon,
    keyHint: "platform.minimaxi.com → subscribe to a Coding Plan → API Key",
    endpoints: {
      anthropic: anthropic("https://api.minimaxi.com/anthropic"),
      openai: { baseUrl: "https://api.minimaxi.com", useFullUrl: false, openaiEndpoint: "/v1/responses", customHeaders: null },
    },
    models: [
      entry("MiniMax-M3", "MiniMax M3", 1000000, 65536),
      entry("MiniMax-M2.7", "MiniMax M2.7", 205000, 32768),
    ],
  },
];

export const trimTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const presetEndpoint = (preset: ModelPreset, type: ModelType): ModelPresetEndpoint => preset.endpoints[type];
