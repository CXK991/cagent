// Minimal i18n for the Cagent UI. Currently 简体中文 (zh) and English (en).

export type Lang = "zh" | "en";

export const LANG_OPTIONS: Array<{ id: Lang; label: string }> = [
  { id: "zh", label: "简体中文" },
  { id: "en", label: "English" },
];

const zh = {
  // Chat view
  chatTitle: "Cagent 对话",
  chatPlaceholder: "问 AI 助手…（@ 引用笔记，Shift+Enter 换行）",
  addImage: "添加图片（识图）",
  newConversation: "新对话（清空上下文）",
  send: "发送",
  stop: "停止",
  contextCleared: "已清空上下文，开始新对话。",
  agentStopping: "Cagent：正在停止…",
  noApiKey: "Cagent：请先在设置中填写 API Key。",
  noTextAnswer: "（无文字回复）",

  // Image recognition
  visionNotEnabled: "Cagent：请先在「设置 → 视觉模型」中打开图片识别开关。",
  visionNoKey: "Cagent：请先在设置中填写视觉模型 API Key。",
  recognizing: "📷 正在识别图片…",
  recognized: "📷 已识别（",
  recognitionFailed: "📷 识别失败：",
  visionError: "Cagent 识图：",

  // Settings
  language: "界面语言",
  languageDesc: "选择插件界面显示的语言。",
  baseUrl: "接口地址",
  baseUrlDesc: "OpenAI 兼容 API 地址，例如 https://api.openai.com/v1 或 http://localhost:11434/v1（Ollama）",
  apiKey: "API Key",
  apiKeyDesc: "接口的 Bearer 令牌。",
  model: "模型",
  modelDesc: "从接口获取模型列表，或手动输入。",
  modelPlaceholder: "例如 gpt-4o-mini, deepseek-chat",
  notSet: "（未设置）",
  fetchModels: "从接口获取模型列表",
  setBaseUrlFirst: "Cagent：请先填写接口地址。",
  fetchingModels: "Cagent：正在获取模型列表…",
  noModelsReturned: "Cagent：接口未返回模型（请检查接口地址 / API Key）——已切换到手动输入。",
  foundModels: "Cagent：找到 {n} 个模型。",
  switchToDropdown: "切换到下拉选择",
  switchToManual: "切换到手动输入",

  vision: "视觉模型（图片识别）",
  visionDesc: "用独立的多模态模型识别图片后，再把文字交给文本模型。启用后对话中出现 📷 按钮。",
  visionBaseUrl: "视觉模型接口地址",
  visionBaseUrlDesc: "视觉模型接口，例如阿里云百炼：https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionApiKey: "视觉模型 API Key",
  visionApiKeyDesc: "视觉接口的令牌（百炼的 API Key 可直接使用）。",
  visionModel: "视觉模型",
  visionModelDesc: "多模态模型 ID，例如 qwen-vl-plus、qwen-vl-max、gpt-4o-mini。",

  openMode: "对话打开方式",
  openModeDesc: "左侧栏图标点击后在哪里打开对话。两个命令始终可用。",
  sidebar: "侧边栏（右侧栏）",
  tab: "独立标签页（主区域）",

  maxIterations: "最大工具调用轮数",
  maxIterationsDesc: "每条用户消息允许的工具调用轮数上限。",
  unlimited: "无限模式",
  unlimitedDesc: "取消轮数上限：工具调用一直持续到模型不再调用为止。会禁用上面的上限。",
  requireConsent: "修改前确认",
  requireConsentDesc: "任何会修改笔记或执行命令的工具执行前都请求确认（删除、覆盖、编辑、frontmatter、命令）。推荐开启。",
  truncate: "长文件截断",
  truncateDesc: "限制单次工具调用上传的文件行数。关闭则总是发送完整内容（可能超出上下文或更耗 token）。",
  maxLines: "单次读取最大行数",
  maxLinesDesc: "截断阈值：工具每次调用最多返回这些行（10–2000）。",

  // Commands / ribbon
  openSidebar: "在侧边栏打开 Cagent 对话",
  openTab: "在新标签页打开 Cagent 对话",
  undoLast: "撤销 AI 最近一次修改",
  openRibbon: "打开 Cagent 对话",
};

export type Key = keyof typeof zh;

const en: Record<Key, string> = {
  chatTitle: "Cagent chat",
  chatPlaceholder: "Ask the AI… (@ to reference notes, Shift+Enter for newline)",
  addImage: "Add an image (vision)",
  newConversation: "New conversation (clear context)",
  send: "Send",
  stop: "Stop",
  contextCleared: "Context cleared. New conversation started.",
  agentStopping: "Cagent: stopping…",
  noApiKey: "Cagent: set the API key in settings first.",
  noTextAnswer: "(no text answer)",

  visionNotEnabled: "Cagent: enable 'Vision model' in settings to use images.",
  visionNoKey: "Cagent: set the Vision API key in settings.",
  recognizing: "📷 Recognizing image…",
  recognized: "📷 Recognized (",
  recognitionFailed: "📷 Recognition failed: ",
  visionError: "Cagent vision: ",

  language: "Interface language",
  languageDesc: "Language used for the plugin UI.",
  baseUrl: "Base URL",
  baseUrlDesc: "OpenAI-compatible API base, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 (Ollama)",
  apiKey: "API key",
  apiKeyDesc: "Bearer token for the API.",
  model: "Model",
  modelDesc: "Pick a model from the endpoint (refresh to fetch the list), or type one manually.",
  modelPlaceholder: "e.g. gpt-4o-mini, deepseek-chat",
  notSet: "(not set)",
  fetchModels: "Fetch model list from the endpoint",
  setBaseUrlFirst: "Cagent: set the Base URL first.",
  fetchingModels: "Cagent: fetching model list…",
  noModelsReturned: "Cagent: no models returned (check Base URL / API key) — switched to manual input.",
  foundModels: "Cagent: found {n} model(s).",
  switchToDropdown: "Switch to dropdown",
  switchToManual: "Switch to manual input",

  vision: "Vision model (image recognition)",
  visionDesc: "Recognize images with a separate multimodal model before they reach the text model. Enable to use the 📷 image button in chat.",
  visionBaseUrl: "Vision Base URL",
  visionBaseUrlDesc: "OpenAI-compatible endpoint for the vision model, e.g. DashScope: https://dashscope.aliyuncs.com/compatible-mode/v1",
  visionApiKey: "Vision API key",
  visionApiKeyDesc: "Bearer token for the vision endpoint. DashScope key works here.",
  visionModel: "Vision model",
  visionModelDesc: "Multimodal model id, e.g. qwen-vl-plus, qwen-vl-max, or gpt-4o-mini.",

  openMode: "Chat open mode",
  openModeDesc: "Where the ribbon icon opens the agent chat. Both commands stay available regardless.",
  sidebar: "Sidebar (right dock)",
  tab: "Standalone tab (main area)",

  maxIterations: "Max tool iterations",
  maxIterationsDesc: "Safety cap on tool-call rounds per user message.",
  unlimited: "Unlimited mode",
  unlimitedDesc: "Remove the iteration cap: tool calls continue until the model stops calling tools. Disables the cap above.",
  requireConsent: "Require confirmation",
  requireConsentDesc: "Ask for approval before any tool that modifies the vault or runs commands (delete, overwrite, edit, frontmatter, commands). Recommended.",
  truncate: "Truncate long files",
  truncateDesc: "Limit how much of a file the agent uploads in one tool call. Turn off to always send full content (may exceed context or cost more tokens).",
  maxLines: "Max lines per read",
  maxLinesDesc: "Line threshold for truncation: tools return at most this many lines per call (10–2000).",

  openSidebar: "Open Cagent chat in sidebar",
  openTab: "Open Cagent chat in a new tab",
  undoLast: "Undo last agent change",
  openRibbon: "Open Cagent chat",
};

/** Translate a key into the selected language. `{n}` placeholders are replaced from vars. */
export function t(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  let s = (lang === "zh" ? zh : en)[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
