# Cagent — 个人 AI 学习助手

> 基于 [obsidian-agent](https://github.com/munroe153/obsidian-agent) 二次开发，专为**考研错题整理与知识管理**设计的 Obsidian 插件。

## 特性

- **AI 对话**：基于 OpenAI 兼容接口，文本模型任意选（DeepSeek、OpenAI、Ollama…）。
- **图片识别（识图）**：对话中可 📷 上传图片 → 独立多模态模型（如千问 Qwen-VL）识别为文字 → 交回文本模型继续分析。适合拍错题、拍板书。
- **Agent 工具集**：完整保留原插件的 27 个工具（读笔记、搜索、创建/编辑、frontmatter、记忆等）。
- **双语言界面**：简体中文 / English，设置页一键切换。
- **桌面端 + 移动端**：同一套代码，手机 Obsidian 可用。

### 对话体验

- AI 回答按 **Markdown 渲染**（公式、代码块、列表、表格）。
- **思考过程**与**工具调用**分别收纳进可折叠面板，点标题展开/收起，界面干净不刷屏。
- 每条消息**一键复制**；助手消息带圆形机器人头像。
- 输入框**自动增高**，圆角边框，聚焦高亮。

### 设置（参考 Copilot 风格，按分组组织）

- **服务商预设**：DeepSeek / OpenAI / 通义千问 / Ollama 一键填入接口与推荐模型。
- **模型参数**：温度（0–2）、最大输出 token（256–16384）。
- **自定义系统提示词**：定义 AI 角色与行为（如考研数学辅导老师）。
- **对话显示**：思考过程默认折叠、显示工具调用、自动滚动。
- **对话历史**：一键清空全部会话。

## 安装

### 手动安装

1. 下载 `main.js`、`manifest.json`、`styles.css` 三个文件。
2. 在你的 Vault 下创建目录 `.obsidian/plugins/cagent/`（**目录名必须是 `cagent`**）。
3. 把三个文件放进去，重启 Obsidian，在 **设置 → 第三方插件 → 已安装插件** 中启用 **Cagent**。

## 配置

打开 **设置 → Cagent**，设置按分组显示：**通用**（语言）、**文本模型**、**视觉模型（图片识别）**、**对话显示**、**对话历史**。

| 项 | 说明 |
|---|---|
| **服务商预设** | DeepSeek / OpenAI / 通义千问 / Ollama 一键填 baseUrl + 推荐模型 |
| **接口地址 / API Key / 模型** | 文本模型（如 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`） |
| **温度 / 最大输出 token** | 采样随机性与单次回复上限 |
| **自定义系统提示词** | 附加在默认提示词前，定义 AI 角色 |
| **视觉模型（图片识别）** | 打开开关后配置识别接口。千问（DashScope）：`https://dashscope.aliyuncs.com/compatible-mode/v1` + 百炼 API Key + 模型 `qwen-vl-plus` |
| **界面语言** | 简体中文 / English |
| **对话显示** | 思考过程默认折叠、显示工具调用、自动滚动 |
| **对话历史** | 一键清空全部会话 |

## 使用

1. 左侧栏机器人图标（或命令面板搜「打开 Cagent 对话」）打开聊天。
2. 直接打字提问，或点 📷 上传图片识别。
3. `@` 引用笔记，AI 会自动读取相关内容。
4. 让 AI 用 `create_note` 等工具把错题整理成 Markdown 存进 Vault。

## 开发

```bash
npm install        # 安装依赖（国内可用 --registry=https://registry.npmmirror.com）
npm run build      # tsc 类型检查 + esbuild 打包，产物为 main.js
```

## 致谢

- 核心 agent 引擎、工具集来自 [obsidian-agent](https://github.com/munroe153/obsidian-agent)（MIT）。

## License

MIT（详见 `LICENSE`）。
