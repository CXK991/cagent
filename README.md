# Cagent — 个人 AI 学习助手

> 基于 [obsidian-agent](https://github.com/munroe153/obsidian-agent) 二次开发，专为**考研错题整理与知识管理**设计的 Obsidian 插件。

## 特性

- **AI 对话**：基于 OpenAI 兼容接口，文本模型任意选（DeepSeek、OpenAI、Ollama…）。
- **图片识别（识图）**：对话中可 📷 上传图片 → 独立多模态模型（如千问 Qwen-VL）识别为文字 → 交回文本模型继续分析。适合拍错题、拍板书。
- **Agent 工具集**：完整保留原插件的 27 个工具（读笔记、搜索、创建/编辑、frontmatter、记忆等）。
- **双语言界面**：简体中文 / English，设置页一键切换。
- **桌面端 + 移动端**：同一套代码，手机 Obsidian 可用。
- **对话体验**：AI 回答按 Markdown 渲染（公式、代码块、列表），每条消息可一键复制；输入框自动增高。

## 安装

### 手动安装

1. 下载 `main.js`、`manifest.json`、`styles.css` 三个文件。
2. 在你的 Vault 下创建目录 `.obsidian/plugins/cagent/`（**目录名必须是 `cagent`**）。
3. 把三个文件放进去，重启 Obsidian，在 **设置 → 第三方插件 → 已安装插件** 中启用 **Cagent**。

## 配置

打开 **设置 → Cagent**：

| 项 | 说明 |
|---|---|
| **接口地址 / API Key / 模型** | 文本模型（如 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`） |
| **视觉模型（图片识别）** | 打开开关后配置识别接口。千问（DashScope）：`https://dashscope.aliyuncs.com/compatible-mode/v1` + 百炼 API Key + 模型 `qwen-vl-plus` |
| **界面语言** | 简体中文 / English |

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
