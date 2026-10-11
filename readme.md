# 📖 novel-reader

一个本地运行的「小说阅读 + AI 自动配图」Web 工具：粘贴或导入小说章节，由大模型自动挑出适合插图的场景、生成英文绘图提示词，再调用本地 **ComfyUI** 或 **NovelAI** 把插画批量画出来。

---

## ✨ 功能特性

- **章节导入**：粘贴文本或上传文件，快速切分章节
- **AI 场景分析**：调用 OpenAI 兼容接口，自动从章节中提取 1–5 个适合配图的场景，并为每个场景生成：
  - 中文场景描述（人物 / 动作 / 环境 / 氛围 / 光影）
  - 英文绘图提示词
  - 原文定位句（anchor）
- **双生图引擎**：
  - **ComfyUI**：连接本地 `127.0.0.1:8188`，支持自定义工作流 JSON，自动注入正面提示词、负面提示词、随机 Seed，支持「永久提示词」前置/后置拼接
  - **NovelAI**：通过中转站调用 `nai-diffusion` 系列模型，支持尺寸、采样器、步数、CFG 等参数
- **一键配图**：分析完成后自动为每个场景逐张生图（最多 5 张），并自动入库
- **配置中心**：LLM API、ComfyUI 工作流、NovelAI 参数全部在网页端可视化配置
- **插图库**：历史生成的插图自动保存，支持查看、复制提示词、换 seed 重画、下载、删除
- **阅读器体验**：字号调节（A-/A+）、日间/夜间/羊皮纸三种主题、阅读进度自动记忆
- **局域网访问**：默认仅本机监听（127.0.0.1），在 `.env` 中改 `HOST=0.0.0.0` 后手机同 WiFi 可访问

---

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express 5 |
| 前端 | 原生 HTML / CSS / JavaScript（无框架） |
| 文件上传 | multer |
| HTTP 请求 | axios |
| 环境变量 | dotenv |
| LLM | OpenAI Chat Completions 兼容接口 |
| 生图 | ComfyUI API（本地） / NovelAI API（中转） |

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd novel-reader
npm install
```

### 2. 配置环境变量

复制 `.env`（项目根目录已提供），按需要修改：

```env
PORT=3000
LLM_API_KEY=你的LLM Key
LLM_API_URL=https://gcli.ggchan.dev/v1/chat/completions

# 可选：ComfyUI 地址与默认模型
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_MODEL=sd_xl_base_1.0.safetensors

# 可选：NovelAI（不配则 NovelAI 路线不可用）
NOVELAI_API_KEY=你的NovelAI Key
NOVELAI_API_URL=https://dangao.iisbo.com/api/v1/novelai
```

### 3. 启动服务

```bash
npm start        # 或 node server.js
npm run dev      # 开发模式，文件改动自动重启
```

启动后控制台会打印访问地址：

- 本机：http://localhost:3000
- 手机：http://<电脑局域网IP>:3000（手机与电脑需在同一 WiFi）

> **前置依赖**：使用 ComfyUI 路线前，请先在本机启动 ComfyUI（默认端口 8188）。

---

## 📁 目录结构

```
novel-reader/
├── server.js                  # Express 后端主程序
├── package.json
├── .env                       # 环境变量（API Key 等，切勿提交到 Git）
├── style.css                  # 全局样式
│
├── index.html                 # 📖 小说阅读器主页面
├── chapter-parser.html         # 📥 导入 / 切分章节
├── ai-illustrator.html        # 🎨 AI 自动配图主界面（分析 + 生图）
├── api-config.html            # ⚙️ LLM API 配置中心
├── comfyui-config.html        # 🎨 ComfyUI 工作流配置
├── comfyui-test.html          # 🧪 ComfyUI 工作流连通性测试
├── novelai-api-test.html      # 🎨 NovelAI API 测试
├── novelai-test.html          # 🎨 NovelAI 连接测试
│
├── uploads/                  # 上传的章节文件（multer 自动创建）
├── images/                   # 生成 / 静态图片
└── node_modules/
```

---

## 🔌 API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/health` | 健康检查，返回各服务配置状态 |
| POST | `/api/analyze` | AI 分析章节（长章节自动分段合并） |
| POST | `/api/generate` | 通过 ComfyUI 生成图片（串行队列，图片自动落盘到 `images/comfy/`） |
| POST | `/api/novelai-generate` | 通过 NovelAI 生成图片（base64 自动落盘到 `images/novelai/`） |
| GET  | `/api/novelai-models` | 获取 NovelAI 可用模型列表 |
| POST | `/api/analyze-and-generate` | 一站式：分析章节并批量生图，自动写入插图库 |
| POST | `/api/llm-models` | 获取 LLM 可用模型列表 |
| GET  | `/api/chapters` | 章节列表 |
| POST | `/api/chapters` | 保存章节（带 id 则更新） |
| DELETE | `/api/chapters/:id` | 删除章节（级联删除其插图） |
| GET  | `/api/illustrations?chapterId=` | 插图库（可按章节过滤） |
| POST | `/api/illustrations` | 新增插图记录 |
| DELETE | `/api/illustrations/:id` | 删除插图记录 |

数据持久化在 `data/chapters.json` 和 `data/illustrations.json`，生成的图片保存在 `images/comfy/`、`images/novelai/`。

### `/api/analyze` 请求示例

```json
{
  "title": "第一章 下山",
  "content": "章节正文……（后端只取前 3000 字）",
  "model": "gpt-4"
}
```

返回：

```json
{
  "success": true,
  "scenes": [
    {
      "scene": "主角站在山巅眺望远方",
      "prompt": "A lone figure standing on a mountain peak……",
      "anchor": "主角站在山巅，目光投向远方"
    }
  ]
}
```

> 未配置 `LLM_API_KEY` 时，接口会返回内置 mock 数据，方便前端调试。

---

## ⚙️ ComfyUI 自定义工作流

在 `comfyui-config.html` 中粘贴 ComfyUI 导出的完整工作流 JSON，并指定：

- **正面提示词节点 ID**（默认 `6`）
- **负面提示词节点 ID**（默认 `7`）
- **Seed 节点 ID**（可空，后端会自动注入随机 seed）
- **永久提示词**：可作为固定风格词前置（prefix）或后置（suffix）拼接到每次 prompt 上

后端会自动兼容 `text` / `positive` 字段名，以及 `seed` / `noise_seed` 字段名。

未配置工作流时，使用内置默认工作流（SDXL，1024×1024，euler，20 steps，cfg 7）。

---

## ⚠️ 注意事项

1. **`.env` 含明文 API Key**，项目已附带 `.gitignore`（排除 `.env`、`node_modules/`、`uploads/`、`images/`、`data/`），切勿手动强制提交。
2. 服务默认仅监听 `127.0.0.1`；如需手机访问改 `HOST=0.0.0.0`。此时局域网内任何人都能调用接口消耗 API 额度，请勿在不可信网络下开放。
3. 使用 NovelAI 路线前必须配置 `NOVELAI_API_KEY`，否则接口返回 400。
4. ComfyUI 生图走**串行队列**（一次只跑一个任务），复杂工作流或模型首次加载最长等待 120 秒，超时会明确报错。
5. 自定义 ComfyUI 工作流时若节点 ID 填写错误（如正面提示词节点不存在），后端会直接返回明确错误，不会静默生成空白图。
6. 章节内容会按约 3500 字分段发给 LLM 分析后合并，长章节也能覆盖到后半段场景。
