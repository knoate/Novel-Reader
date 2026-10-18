// server.js
// ============================================================
//  小说阅读器后端 - ComfyUI + NovelAI + AI 分析 + 本地持久化
// ============================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ============================================================
//  1. 基础配置
// ============================================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // 默认仅本机；手机访问改 0.0.0.0

const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const NOVELAI_API_KEY = process.env.NOVELAI_API_KEY || '';
const NOVELAI_API_URL = process.env.NOVELAI_API_URL || 'https://dangao.iisbo.com/api/v1/novelai';
const DEFAULT_MODEL = process.env.COMFYUI_MODEL || 'sd_xl_base_1.0.safetensors';

// 确保目录
const DIRS = ['uploads', 'images', path.join('images', 'comfy'), path.join('images', 'novelai'), path.join('images', 'grok'), 'data'];
for (const d of DIRS) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ============================================================
//  2. 本地持久化（章节 + 插图库）
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
const NOVELS_FILE = path.join(DATA_DIR, 'novels.json');
const CHAPTERS_FILE = path.join(DATA_DIR, 'chapters.json');
const ILLUS_FILE = path.join(DATA_DIR, 'illustrations.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');
const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');

function loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
// ============================================================
//  生图日志（记录每次生成的路由 + 提示词）
// ============================================================
const GEN_LOG_FILE = path.join(DATA_DIR, 'generation_log.jsonl');
function logGen(route, opts = {}) {
    try {
        const entry = {
            ts: new Date().toISOString(),
            route,
            engine: opts.engine || opts.model || '',
            prompt: (opts.prompt || '').slice(0, 2000),
            negative: (opts.negative_prompt || '').slice(0, 1000),
            model: opts.model || '',
            seed: opts.seed,
            workflow: opts.workflowId || (opts.workflowConfig && opts.workflowConfig.modelName) || '',
            source: opts.source || 'api'
        };
        fs.appendFileSync(GEN_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) { /* 日志失败不影响生图 */ }
}
// 查询生图日志
function readGenLog(limit = 200) {
    try {
        if (!fs.existsSync(GEN_LOG_FILE)) return [];
        const lines = fs.readFileSync(GEN_LOG_FILE, 'utf8').split('\n').filter(l => l.trim());
        const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return all.slice(-limit).reverse();
    } catch { return []; }
}
let novels = loadJson(NOVELS_FILE, []);
let chapters = loadJson(CHAPTERS_FILE, []);
let illustrations = loadJson(ILLUS_FILE, []);
let statsLog = loadJson(STATS_FILE, []);
let roles = loadJson(ROLES_FILE, {}); // { novelId: [{ name, desc }] }
let characters = loadJson(CHARACTERS_FILE, {}); // { novelId: [{ name, role, identity, appearance, personality, relation, firstChapter, appearances, lastChapter }] }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function logStat(engine, success) {
    try {
        statsLog.push({
            t: Date.now(),
            engine: engine || 'unknown',
            success: !!success
        });
        // 只保留最近 2 万条
        if (statsLog.length > 20000) statsLog = statsLog.slice(-20000);
        saveJson(STATS_FILE, statsLog);
    } catch (e) {}
}

// 首次启动：把已有数据归入默认小说
if (!novels.length) {
    const defaultId = uid();
    novels = [{ id: defaultId, name: '我的小说', createdAt: new Date().toISOString() }];
    chapters = chapters.map(c => ({ ...c, novelId: c.novelId || defaultId }));
    illustrations = illustrations.map(i => ({ ...i, novelId: i.novelId || defaultId }));
    saveJson(NOVELS_FILE, novels);
    saveJson(CHAPTERS_FILE, chapters);
    saveJson(ILLUS_FILE, illustrations);
}

// ============================================================
//  3. LLM 分析（分段 + 稳健 JSON 提取）
// ============================================================
function chunkText(text, size = 3500) {
    if (text.length <= size) return [text];
    // 优先按段落切
    const paragraphs = text.split(/\n+/);
    const chunks = [];
    let buf = '';
    for (const p of paragraphs) {
        if ((buf + p).length > size && buf) { chunks.push(buf); buf = p; }
        else buf += (buf ? '\n' : '') + p;
    }
    if (buf) chunks.push(buf);
    // 兜底：超长段落硬切
    const final = [];
    for (const c of chunks) {
        if (c.length <= size * 1.5) final.push(c);
        else for (let i = 0; i < c.length; i += size) final.push(c.slice(i, i + size));
    }
    return final;
}

function extractScenesJson(text) {
    // 1) ```json ... ``` 代码块
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : text;
    // 2) 第一个 JSON 数组
    const m = candidate.match(/\[[\s\S]*\]/);
    return JSON.parse(m ? m[0] : candidate);
}

async function callLlm(prompt, model, signal, opts = {}) {
    const useModel = model || process.env.LLM_MODEL || 'gpt-4';
    const apiUrl = opts.apiUrl || LLM_API_URL;
    const apiKey = opts.apiKey || LLM_API_KEY;
    // 智能补全 chat/completions 路径
    let chatUrl = apiUrl.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(chatUrl)) {
        if (/\/v\d+$/.test(chatUrl)) chatUrl = chatUrl + '/chat/completions';
        else if (!/\/v\d+\//.test(chatUrl)) chatUrl = chatUrl + '/v1/chat/completions';
    }
    console.log('🤖 LLM 请求:', chatUrl, '模型:', useModel);
    const res = await axios.post(chatUrl, {
        model: useModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
    }, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000,
        signal
    });
    return res.data.choices[0].message.content;
}

const ANALYZE_SYSTEM = `你是一位专业的小说插画师和图像分析师。请分析以下小说章节，找出适合生成精美插图的场景。
要求：
1. 找出 1-5 个最适合配图的场景
2. 每个场景包含：人物、动作、环境、氛围、光影
3. 生成英文绘图提示词（用于 AI 绘画）
4. 用原文中的一句话标注场景位置（anchor）
只输出 JSON 数组，不要任何解释：
[{"scene":"中文场景描述","prompt":"英文绘图提示词","anchor":"原文定位句"}]`;

async function analyzeChapters(title, content, model, instruction = '', maxScenes = 5, signal, opts = {}) {
    if (!LLM_API_KEY) {
        return [
            { scene: '主角站在山巅眺望远方', prompt: 'A lone figure standing on a mountain peak, overlooking a vast fantasy landscape, dramatic sunset lighting, epic scale, digital art, high quality', anchor: '主角站在山巅，目光投向远方' },
            { scene: '神秘的森林小径', prompt: 'A mysterious forest path with glowing mushrooms, ancient trees, ethereal atmosphere, fantasy art, detailed, beautiful lighting', anchor: '森林小径蜿蜒向前，不知通往何处' }
        ];
    }
    // 角色设定库：如果传了角色，拼成英文参考卡供 AI 在写 prompt 时使用
    let roleExtra = '';
    if (opts.roles && opts.roles.length) {
        const lines = opts.roles
            .filter(r => r && r.name && r.desc)
            .map(r => `- ${r.name}: ${r.desc}`);
        if (lines.length) {
            roleExtra = `\n\n【角色设定卡（当场景涉及这些角色时，prompt 必须严格按其外貌/服装/气质描述，不得随意改动外形）】\n${lines.join('\n')}`;
        }
    }
    // 用户自定义的「绘图提示词生成规则」追加到系统指令
    const sysExtra = (instruction ? `\n\n【附加规则：你生成的 prompt 字段必须遵守】\n${instruction}` : '') + roleExtra;
    const chunks = chunkText(content || '');
    const allScenes = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const text = await callLlm(`${ANALYZE_SYSTEM}${sysExtra}\n\n章节标题：${title || ''}\n章节片段（${i + 1}/${chunks.length}）：\n${chunks[i]}`, model, signal, opts);
            const arr = extractScenesJson(text);
            if (Array.isArray(arr)) allScenes.push(...arr);
        } catch (e) {
            console.warn(`⚠️ 第 ${i + 1} 段分析失败:`, e.message);
        }
    }
    return allScenes.slice(0, maxScenes);
}

// ============================================================
//  4. ComfyUI 生图（串行队列 + 错误读取 + 图片落盘）
// ============================================================
const comfyQueue = [];
let comfyRunning = false;
function enqueueComfy(taskFn) {
    return new Promise((resolve, reject) => {
        comfyQueue.push({ taskFn, resolve, reject });
        drainComfy();
    });
}
async function drainComfy() {
    if (comfyRunning) return;
    comfyRunning = true;
    while (comfyQueue.length) {
        const job = comfyQueue.shift();
        try { job.resolve(await job.taskFn()); }
        catch (e) { job.reject(e); }
    }
    comfyRunning = false;
}

function setNodeText(node, value) {
    if (!node || !node.inputs) return false;
    if (node.inputs.text !== undefined) { node.inputs.text = value; return true; }
    if (node.inputs.positive !== undefined) { node.inputs.positive = value; return true; }
    if (node.inputs.negative !== undefined) { node.inputs.negative = value; return true; }
    return false;
}

// 提示词模板：{prompt} 占位符会被 LLM 生成的场景提示词替换
function renderTemplate(template, vars) {
    if (!template || !String(template).trim()) return vars.__fallback || '';
    let out = String(template);
    for (const k in vars) {
        if (k === '__fallback') continue;
        out = out.split('{' + k + '}').join(vars[k]);
    }
    return out;
}

function buildComfyWorkflow(prompt, negativePrompt = '', config) {
    config = config || {};
    let finalPrompt = prompt || '';
    if (config.permanentPositive) {
        finalPrompt = config.promptPosition === 'suffix'
            ? finalPrompt + ', ' + config.permanentPositive
            : config.permanentPositive + ', ' + finalPrompt;
    }

    if (config.workflowJson) {
        const workflow = JSON.parse(config.workflowJson);
        const posNode = config.positiveNode || '6';
        const negNode = config.negativeNode || '7';
        const seedNode = config.seedNode || '';

        if (!workflow[posNode]) {
            throw new Error(`正面提示词节点 "${posNode}" 不存在于工作流中，请检查节点 ID`);
        }
        if (!setNodeText(workflow[posNode], finalPrompt)) {
            throw new Error(`节点 "${posNode}" 上找不到 text/positive 字段，请确认该节点是 CLIPTextEncode`);
        }
        if (negNode && workflow[negNode]) {
            setNodeText(workflow[negNode], negativePrompt || 'worst quality, low quality, blurry, ugly');
        }
        if (seedNode && workflow[seedNode] && workflow[seedNode].inputs) {
            const seed = Math.floor(Math.random() * 1e9);
            if (workflow[seedNode].inputs.seed !== undefined) workflow[seedNode].inputs.seed = seed;
            else if (workflow[seedNode].inputs.noise_seed !== undefined) workflow[seedNode].inputs.noise_seed = seed;
        }
        return { workflow, seed: seedNode && workflow[seedNode] ? (workflow[seedNode].inputs.seed ?? workflow[seedNode].inputs.noise_seed) : undefined };
    }

    const modelName = config.modelName || DEFAULT_MODEL;
    return {
        seed: Math.floor(Math.random() * 1e9),
        workflow: {
            "3": { class_type: "KSampler", inputs: { seed: Math.floor(Math.random() * 1e9), steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
            "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: modelName } },
            "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
            "6": { class_type: "CLIPTextEncode", inputs: { text: finalPrompt, clip: ["4", 1] } },
            "7": { class_type: "CLIPTextEncode", inputs: { text: negativePrompt || "worst quality, low quality, blurry, deformed, ugly", clip: ["4", 1] } },
            "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
            "9": { class_type: "SaveImage", inputs: { filename_prefix: "novel_ai", images: ["8", 0] } }
        }
    };
}

async function downloadComfyImage(image, base) {
    const b = (base || COMFYUI_URL).replace(/\/$/, '');
    const url = `${b}/view?filename=${encodeURIComponent(image.filename)}&type=${image.type || 'output'}&subfolder=${encodeURIComponent(image.subfolder || '')}`;
    console.log('⬇️ 下载图片:', url);
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    const ext = (image.filename.split('.').pop() || 'png').toLowerCase();
    const localName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const localPath = path.join('images', 'comfy', localName);
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    console.log('✅ 已保存到:', localPath, resp.data.length, 'bytes');
    return `/images/comfy/${localName}`;
}

async function generateComfyImage(prompt, negativePrompt, workflowConfig, templates, comfyUrl) {
    workflowConfig = workflowConfig || {};
    templates = templates || {};
    const base = (comfyUrl || COMFYUI_URL).replace(/\/$/, '');
    return enqueueComfy(async () => {
        // 应用提示词模板：{prompt} -> LLM 生成的场景提示词
        const finalPrompt = renderTemplate(templates.promptTemplate, { prompt, __fallback: prompt });
        const finalNeg = renderTemplate(templates.negativeTemplate, { prompt, __fallback: negativePrompt });
        const { workflow, seed } = buildComfyWorkflow(finalPrompt, finalNeg, workflowConfig);
        const submit = await axios.post(`${base}/prompt`, { prompt: workflow }, { timeout: 30000 });
        const promptId = submit.data.prompt_id;
        if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');

        // 轮询结果
        const start = Date.now();
        let pollCount = 0;
        while (Date.now() - start < 300000) {
            await new Promise(r => setTimeout(r, 2000));
            pollCount++;
            const histRes = await axios.get(`${base}/history/${promptId}`, { timeout: 15000 });
            const hist = histRes.data;
            const entry = hist[promptId];
            if (!entry) {
                if (pollCount % 15 === 0) console.log(`⏳ 等待生成... ${((Date.now()-start)/1000)|0}s, history为空`);
                continue;
            }
            if (entry.status && entry.status.status_str === 'error') {
                const msgs = entry.status.messages || [];
                throw new Error('ComfyUI 工作流执行失败: ' + JSON.stringify(msgs).slice(0, 300));
            }
            const outputs = entry.outputs || {};
            for (const nodeId in outputs) {
                const imgs = outputs[nodeId].images;
                if (imgs && imgs.length) {
                    console.log(`✅ 拿到图片:`, imgs[0]);
                    const localUrl = await downloadComfyImage(imgs[0], base);
                    return { url: localUrl, seed, filename: imgs[0].filename };
                }
            }
            if (pollCount % 15 === 0) console.log(`⏳ 等待生成... ${((Date.now()-start)/1000)|0}s, outputs:`, Object.keys(outputs));
        }
        throw new Error('ComfyUI 生成超时（120s），工作流可能过复杂或队列堵塞');
    });
}

// ============================================================
//  5. NovelAI 生图
// ============================================================
async function generateNovelAIImage(opts = {}) {
    let { prompt, negative_prompt, width = 832, height = 1216, steps = 28, sampler = 'k_euler_ancestral', scale = 5.0, model, seed, promptTemplate, negativeTemplate } = opts;
    const naiUrl = opts.apiUrl || NOVELAI_API_URL;
    const naiKey = opts.apiKey || NOVELAI_API_KEY;
    if (!naiKey) throw new Error('未配置 NovelAI API Key');
    // 应用模板
    prompt = renderTemplate(promptTemplate, { prompt, __fallback: prompt });
    negative_prompt = renderTemplate(negativeTemplate, { prompt, __fallback: negative_prompt || 'nsfw, lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry' });
    const payload = {
        input: prompt,
        model: model || 'nai-diffusion-5-full',
        action: 'generate',
        parameters: {
            width, height, scale, sampler, steps,
            n_samples: 1,
            noise_schedule: 'karras',
            negative_prompt
        }
    };
    if (seed) payload.parameters.seed = seed;

    const resp = await axios.post(naiUrl, payload, {
        headers: { 'Authorization': `Bearer ${naiKey}`, 'Content-Type': 'application/json' },
        timeout: 120000
    });
    if (!resp.data.success) throw new Error(resp.data.error || 'NovelAI 生成失败');

    // 把 base64 图片落盘
    const out = [];
    for (const img of (resp.data.images || [])) {
        if (typeof img === 'string' && /^[A-Za-z0-9+/=]{100,}$/.test(img)) {
            const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
            fs.writeFileSync(path.join('images', 'novelai', name), Buffer.from(img, 'base64'));
            out.push(`/images/novelai/${name}`);
        } else {
            out.push(img); // 已经是 URL
        }
    }
    return out;
}

// ============================================================
//  5.5 Grok / Banana 生图（OpenAI 兼容图像接口，默认 xAI）
// ============================================================
async function generateGrokImage(opts = {}) {
    let { prompt, width = 1024, height = 1024, model, apiUrl, apiKey } = opts;
    if (!prompt) throw new Error('缺少提示词');
    // 规范化 API 地址：如果用户填的是 base URL（如 /v1），自动补 /images/generations
    let url = (apiUrl || process.env.GROK_API_URL || 'https://api.x.ai/v1/images/generations').replace(/\/$/, '');
    if (!/\/(images\/generations|chat\/completions)$/.test(url)) {
        // 如果末尾是 /v1 或类似 base，补 /images/generations
        url = url + '/images/generations';
    }
    const key = apiKey || process.env.GROK_API_KEY;
    if (!key) throw new Error('未配置 Grok/Banana API Key');
    if (!model) throw new Error('未选择 Grok 模型，请在配图工具页选择模型');

    let resp;
    try {
        const body = {
            model: model || process.env.GROK_MODEL || 'grok-2-image-1212',
            prompt,
            n: 1,
            response_format: 'b64_json'
        };
        // 长宽比：转成 OpenAI 兼容 size（如 1024x1024 / 832x1216）
        if (width && height) body.size = `${width}x${height}`;
        resp = await axios.post(url, body, {
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: 120000
        });
    } catch (e) {
        const status = e.response?.status;
        const body = e.response?.data;
        console.error(`❌ Grok 接口调用失败 ${status} ${url}`);
        console.error('   返回:', typeof body === 'object' ? JSON.stringify(body).slice(0, 400) : body);
        throw new Error(`Grok 接口 ${status}: ${typeof body === 'object' ? JSON.stringify(body).slice(0, 200) : body}`);
    }

    // 兼容两种返回格式：OpenAI 标准 data:[{b64_json/url}] 或 {images:[{url}]}
    const arr = Array.isArray(resp.data?.data) ? resp.data.data
        : Array.isArray(resp.data?.images) ? resp.data.images : [];
    if (!arr.length) throw new Error('Grok 未返回图片: ' + JSON.stringify(resp.data).slice(0, 200));

    const item = arr[0];
    let buf;
    if (item.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
        const r = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 30000 });
        buf = Buffer.from(r.data);
    } else if (typeof item === 'string') {
        buf = /^[A-Za-z0-9+/=]{100,}$/.test(item) ? Buffer.from(item, 'base64') : null;
        if (!buf) {
            const r = await axios.get(item, { responseType: 'arraybuffer', timeout: 30000 });
            buf = Buffer.from(r.data);
        }
    } else {
        throw new Error('无法解析返回的图片数据');
    }

    const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join('images', 'grok', name), buf);
    return { url: `/images/grok/${name}` };
}

// ============================================================
//  6. 路由
// ============================================================
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok', timestamp: new Date().toISOString(),
        services: {
            llm: LLM_API_KEY ? '已配置' : '未配置(使用模拟数据)',
            comfyui: COMFYUI_URL,
            novelai: NOVELAI_API_KEY ? '已配置' : '未配置'
        }
    });
});

// ---- 章节 CRUD ----
// ---- 小说 CRUD ----
app.get('/api/novels', (req, res) => res.json({ success: true, novels }));
app.post('/api/novels', (req, res) => {
    const name = (req.body.name || '未命名小说').trim() || '未命名小说';
    const novel = { id: uid(), name, createdAt: new Date().toISOString() };
    novels.unshift(novel);
    saveJson(NOVELS_FILE, novels);
    res.json({ success: true, novel });
});
app.put('/api/novels/:id', (req, res) => {
    const idx = novels.findIndex(n => n.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '小说不存在' });
    if (req.body.name) novels[idx].name = req.body.name;
    saveJson(NOVELS_FILE, novels);
    res.json({ success: true, novel: novels[idx] });
});
app.delete('/api/novels/:id', (req, res) => {
    const nid = req.params.id;
    // 清理该小说下所有章节和插图
    const chs = chapters.filter(c => c.novelId === nid);
    chs.forEach(c => extractLocalImages(c.content || '').forEach(deleteLocalImage));
    chapters = chapters.filter(c => c.novelId !== nid);
    const illus = illustrations.filter(i => i.novelId === nid);
    illus.forEach(i => deleteLocalImage(i.image));
    illustrations = illustrations.filter(i => i.novelId !== nid);
    novels = novels.filter(n => n.id !== nid);
    delete roles[nid];
    delete characters[nid];
    saveJson(CHAPTERS_FILE, chapters);
    saveJson(ILLUS_FILE, illustrations);
    saveJson(NOVELS_FILE, novels);
    saveJson(ROLES_FILE, roles);
    saveJson(CHARACTERS_FILE, characters);
    res.json({ success: true });
});

// ---- 角色设定库（按小说）----
app.get('/api/roles', (req, res) => {
    const nid = req.query.novelId;
    const list = nid ? (roles[nid] || []) : [];
    res.json({ success: true, roles: list });
});
app.post('/api/roles', (req, res) => {
    const { novelId, roles: newRoles } = req.body;
    if (!novelId) return res.status(400).json({ error: '缺少 novelId' });
    roles[novelId] = Array.isArray(newRoles) ? newRoles.filter(r => r && r.name && r.desc) : [];
    saveJson(ROLES_FILE, roles);
    res.json({ success: true, roles: roles[novelId] });
});

// ============================================================
//  人物信息库（AI 解析章节，增量更新主角/NPC 表）
// ============================================================
const CHARACTER_SYSTEM = `你是一位资深的小说角色分析师。请分析给定章节中出现的所有人，识别出：
1. name：人物姓名（无姓名则用最显著称呼）
2. role：人物类型，仅填 "主角" 或 "NPC"
3. identity：身份/职业/地位
4. appearance：外貌描写（无则留空）
5. personality：性格特征（无则留空）
6. relation：与主角或故事的关系
7. keyword：该人物在章节中最典型的一个称呼或特征词（用于后续识别）
只输出 JSON 数组，不要任何解释，格式：
[{"name":"","role":"主角","identity":"","appearance":"","personality":"","relation":"","keyword":""}]`;

app.post('/api/characters/analyze', async (req, res) => {
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
        const { novelId, content, title, model } = req.body;
        if (!novelId || !content) return res.status(400).json({ error: '缺少 novelId 或章节内容' });
        const opts = { apiUrl: req.body.llmApiUrl || '', apiKey: req.body.llmApiKey || '' };
        // 传已有角色库作为参考（增量更新）
        const existing = characters[novelId] || [];
        const existingInfo = existing.map(c => `- ${c.name}（${c.role}，${c.identity||''}，${c.appearance||''}，${c.personality||''}）`).join('\n');
        const prompt = `${CHARACTER_SYSTEM}\n\n【该小说已识别的角色（用于去重和补充信息，不要重复新增）】\n${existingInfo || '（暂无）'}\n\n【章节标题】${title || ''}\n【章节内容】\n${content.slice(0, 6000)}`;
        const text = await callLlm(prompt, model, ctrl.signal, opts);
        // 解析 JSON
        let arr = [];
        try {
            const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
            const candidate = fence ? fence[1] : text;
            const m = candidate.match(/\[[\s\S]*\]/);
            arr = JSON.parse(m ? m[0] : candidate);
        } catch (e) {
            return res.status(500).json({ error: 'AI 返回无法解析的人物数据' });
        }
        if (!Array.isArray(arr)) return res.status(500).json({ error: 'AI 未返回人物数组' });

        // 增量合并
        const cur = characters[novelId] || [];
        const merged = cur.slice();
        let added = [], updated = [];
        for (const item of arr) {
            const name = (item.name || '').trim();
            if (!name) continue;
            const idx = merged.findIndex(c => c.name === name);
            if (idx >= 0) {
                // 更新：补充缺失字段
                const before = JSON.stringify(merged[idx]);
                for (const k of ['identity','appearance','personality','relation']) {
                    if (item[k] && !merged[idx][k]) merged[idx][k] = item[k];
                }
                if (item.role === '主角' && merged[idx].role !== '主角') merged[idx].role = '主角';
                merged[idx].lastChapter = title || merged[idx].lastChapter;
                merged[idx].appearances = (merged[idx].appearances || 0) + 1;
                if (JSON.stringify(merged[idx]) !== before) updated.push(merged[idx].name);
            } else {
                merged.push({
                    id: uid(),
                    name,
                    role: item.role === '主角' ? '主角' : 'NPC',
                    identity: item.identity || '', appearance: item.appearance || '',
                    personality: item.personality || '', relation: item.relation || '',
                    keyword: item.keyword || name,
                    firstChapter: title || '', lastChapter: title || '', appearances: 1
                });
                added.push(name);
            }
        }
        characters[novelId] = merged;
        saveJson(CHARACTERS_FILE, characters);
        res.json({ success: true, characters: merged, added, updated });
    } catch (e) {
        if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') return;
        console.error('人物解析失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 获取人物库
app.get('/api/characters', (req, res) => {
    const nid = req.query.novelId;
    const list = nid ? (characters[nid] || []) : [];
    res.json({ success: true, characters: list });
});

// 手动编辑/删除人物
app.post('/api/characters/save', (req, res) => {
    const { novelId, characters: newList } = req.body;
    if (!novelId || !Array.isArray(newList)) return res.status(400).json({ error: '参数错误' });
    characters[novelId] = newList.filter(c => c && c.name);
    saveJson(CHARACTERS_FILE, characters);
    res.json({ success: true, characters: characters[novelId] });
});

// ---- 小说导出（配图完整迁移到另一台设备）----
app.get('/api/novels/:id/export', (req, res) => {
    try {
        const nid = req.params.id;
        const novel = novels.find(n => n.id === nid);
        if (!novel) return res.status(404).json({ error: '小说不存在' });
        const novelChapters = chapters.filter(c => c.novelId === nid);
        const novelIllus = illustrations.filter(i => i.novelId === nid);
        // 收集所有本地图片（章节内 + 插图库）转 base64
        const images = {}; // { '/images/xxx': 'data:image/...;base64,...' }
        const addImage = (url) => {
            if (!url || typeof url !== 'string') return;
            // 章节内容里的 markdown 引用
            if (url.startsWith('/images/')) {
                const clean = url.split('?')[0];
                const fp = path.join(__dirname, decodeURIComponent(clean));
                if (fs.existsSync(fp)) {
                    const mime = clean.endsWith('.png') ? 'image/png' : clean.endsWith('.jpg') || clean.endsWith('.jpeg') ? 'image/jpeg' : clean.endsWith('.webp') ? 'image/webp' : 'image/png';
                    images[clean] = `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`;
                }
            }
        };
        novelChapters.forEach(c => extractLocalImages(c.content || '').forEach(addImage));
        novelIllus.forEach(i => addImage(i.image));
        const payload = {
            type: 'novel-reader-export',
            version: 1,
            exportedAt: new Date().toISOString(),
            novel,
            chapters: novelChapters,
            illustrations: novelIllus,
            roles: roles[nid] || [],
            characters: characters[nid] || [],
            images
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="novel_${encodeURIComponent(novel.name)}_export.json"`);
        res.json(payload);
    } catch (e) {
        console.error('导出失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---- 小说导入（从导出文件恢复）----
app.post('/api/novels/import', async (req, res) => {
    try {
        const p = req.body;
        if (!p || p.type !== 'novel-reader-export') return res.status(400).json({ error: '不是有效的导出文件' });
        // 恢复图片：base64 → 文件（保持 /images/... 路径）
        if (p.images && typeof p.images === 'object') {
            for (const [url, dataUri] of Object.entries(p.images)) {
                if (!dataUri || typeof dataUri !== 'string') continue;
                const comma = dataUri.indexOf(',');
                if (comma === -1) continue;
                const buf = Buffer.from(dataUri.slice(comma + 1), 'base64');
                const clean = url.split('?')[0];
                const fp = path.join(__dirname, decodeURIComponent(clean));
                // 只允许写回 images 目录，防路径穿越
                if (!fp.startsWith(path.join(__dirname, 'images'))) continue;
                fs.mkdirSync(path.dirname(fp), { recursive: true });
                fs.writeFileSync(fp, buf);
            }
        }
        // 写入小说
        const novel = { ...p.novel };
        // 若已存在同名小说则追加时间戳避免冲突
        if (novels.some(n => n.id === novel.id)) {
            novel.id = 'n' + Date.now();
        }
        novels.unshift(novel);
        // 写入章节（把旧 id 对应的 novelId 改为新 id）
        const newId = novel.id;
        const newChapters = (p.chapters || []).map(c => ({ ...c, novelId: newId }));
        newChapters.forEach(c => { if (!c._id) c._id = uid(); });
        const newIllus = (p.illustrations || []).map(i => ({ ...i, novelId: newId }));
        newIllus.forEach(i => { if (!i.id) i.id = uid(); });
        chapters.push(...newChapters);
        illustrations.push(...newIllus);
        roles[newId] = (p.roles || []).filter(r => r && r.name && r.desc);
        characters[newId] = (p.characters || []).filter(c => c && c.name);
        saveJson(NOVELS_FILE, novels);
        saveJson(CHAPTERS_FILE, chapters);
        saveJson(ILLUS_FILE, illustrations);
        saveJson(ROLES_FILE, roles);
        saveJson(CHARACTERS_FILE, characters);
        console.log(`📥 已导入小说《${novel.name}》（${newChapters.length}章）`);
        res.json({ success: true, novel, importedChapters: newChapters.length, importedImages: Object.keys(p.images || {}).length });
    } catch (e) {
        console.error('导入失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/chapters', (req, res) => {
    const nid = req.query.novelId;
    const list = nid ? chapters.filter(c => c.novelId === nid) : chapters;
    res.json({ success: true, chapters: list });
});
app.post('/api/chapters', (req, res) => {
    const { id, title, content, novelId } = req.body;
    if (!content) return res.status(400).json({ error: '缺少章节内容' });
    const nid = novelId || novels[0]?.id;
    if (id) {
        const idx = chapters.findIndex(c => c.id === id);
        if (idx >= 0) {
            chapters[idx] = { ...chapters[idx], title, content, updatedAt: new Date().toISOString() };
            saveJson(CHAPTERS_FILE, chapters);
            return res.json({ success: true, chapter: chapters[idx] });
        }
    }
    const chapter = { id: uid(), title: title || '未命名章节', content, novelId: nid, createdAt: new Date().toISOString() };
    chapters.push(chapter);
    saveJson(CHAPTERS_FILE, chapters);
    res.json({ success: true, chapter });
});

// 章节排序
app.post('/api/chapters/reorder', (req, res) => {
    const { novelId, order } = req.body;
    if (!Array.isArray(order)) return res.json({ success: false, error: 'order 必须是数组' });
    const map = new Map(chapters.map(c => [c.id, c]));
    const kept = [];
    for (const id of order) {
        const ch = map.get(id);
        if (ch) kept.push(ch);
    }
    // 保留不在 order 里的章节（其他小说的）
    const others = chapters.filter(c => !order.includes(c.id));
    chapters.length = 0;
    chapters.push(...kept, ...others);
    saveJson(CHAPTERS_FILE, chapters);
    res.json({ success: true });
});
// 删除本地图片文件（如果是 /images/ 开头的本地路径）
function deleteLocalImage(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('/images/')) return;
    try {
        const fp = path.join(__dirname, decodeURIComponent(url.split('?')[0]));
        if (fp.startsWith(path.join(__dirname, 'images')) && fs.existsSync(fp)) {
            fs.unlinkSync(fp);
            console.log('🗑️ 已删除图片:', fp);
        }
    } catch (e) { console.warn('删图失败:', e.message); }
}

// 从章节正文里提取所有本地图片路径
function extractLocalImages(content) {
    if (!content) return [];
    const re = /!\[[^\]]*\]\((\/images\/[^)]+)\)/g;
    const out = [];
    let m;
    while ((m = re.exec(content)) !== null) out.push(m[1]);
    return out;
}

app.delete('/api/chapters/:id', (req, res) => {
    const idx = chapters.findIndex(c => c.id === req.params.id);
    if (idx >= 0) {
        const ch = chapters[idx];
        // 清理章节里嵌入的本地图片
        extractLocalImages(ch.content || '').forEach(deleteLocalImage);
        chapters.splice(idx, 1);
    }
    // 清理该章节关联的插图记录及其图片
    const orphanIllus = illustrations.filter(i => i.chapterId === req.params.id);
    orphanIllus.forEach(i => deleteLocalImage(i.image));
    illustrations = illustrations.filter(i => i.chapterId !== req.params.id);
    saveJson(CHAPTERS_FILE, chapters);
    saveJson(ILLUS_FILE, illustrations);
    res.json({ success: true });
});

// ---- 插图库 CRUD ----
app.get('/api/illustrations', (req, res) => {
    let list = illustrations;
    if (req.query.novelId) list = list.filter(i => i.novelId === req.query.novelId);
    if (req.query.chapterId) list = list.filter(i => i.chapterId === req.query.chapterId);
    res.json({ success: true, illustrations: list });
});
app.post('/api/illustrations', (req, res) => {
    const rec = { id: uid(), createdAt: new Date().toISOString(), ...req.body };
    illustrations.unshift(rec);
    saveJson(ILLUS_FILE, illustrations);
    res.json({ success: true, illustration: rec });
});
app.delete('/api/illustrations/:id', (req, res) => {
    const idx = illustrations.findIndex(i => i.id === req.params.id);
    if (idx >= 0) {
        deleteLocalImage(illustrations[idx].image);
        illustrations.splice(idx, 1);
    }
    saveJson(ILLUS_FILE, illustrations);
    res.json({ success: true });
});

// ---- AI 分析 ----
app.post('/api/analyze', async (req, res) => {
    try {
        const { title, content, model, analyzeTemplate } = req.body;
        if (!content) return res.status(400).json({ error: '缺少章节内容' });
        const scenes = await analyzeChapters(title, content, model, analyzeTemplate || '');
        res.json({ success: true, scenes, mock: !LLM_API_KEY });
    } catch (e) {
        console.error('分析失败:', e.message);
        res.status(500).json({ error: e.message, details: e.response?.data || '' });
    }
});

// ---- ComfyUI 生图 ----
app.post('/api/generate', async (req, res) => {
    try {
        const { prompt, negative_prompt, workflowConfig, promptTemplate, negativeTemplate, comfyUrl } = req.body;
        if (!prompt) return res.status(400).json({ error: '缺少绘图提示词' });
        logGen('/api/generate', { prompt, negative_prompt, workflowConfig, engine: 'comfyui', source: req.body.source });
        const img = await generateComfyImage(prompt, negative_prompt, workflowConfig, { promptTemplate, negativeTemplate }, comfyUrl);
        res.json({ success: true, image: img });
    } catch (e) {
        console.error('ComfyUI 生图失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---- NovelAI 生图 ----
app.post('/api/novelai-generate', async (req, res) => {
    try {
        logGen('/api/novelai-generate', { ...req.body, engine: 'novelai', source: req.body.source });
        const images = await generateNovelAIImage(req.body);
        res.json({ success: true, images, count: images.length });
    } catch (e) {
        console.error('NovelAI 生图失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 把用户配置的固定前置/后置提示词拼接到 prompt 上
function wrapPrompt(prompt, opts = {}) {
    const pre = (opts.promptPrefix || '').trim();
    const suf = (opts.promptSuffix || '').trim();
    let p = (prompt || '').trim();
    if (pre) p = pre + ', ' + p;
    if (suf) p = p + ', ' + suf;
    return p;
}

// ---- Grok / Banana 生图 ----
app.post('/api/grok-generate', async (req, res) => {
    try {
        const opts = { ...req.body };
        if (opts.grokModel && !opts.model) opts.model = opts.grokModel;
        logGen('/api/grok-generate', { ...opts, engine: 'grok', source: req.body.source });
        opts.prompt = wrapPrompt(opts.prompt, opts);
        const img = await generateGrokImage(opts);
        res.json({ success: true, image: img });
    } catch (e) {
        console.error('Grok 生图失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/novelai-models', (req, res) => {
    res.json({ success: true, models: ['nai-diffusion-5-full', 'nai-diffusion-5', 'nai-diffusion-4-full', 'nai-diffusion-4', 'nai-diffusion-3'] });
});

// ---- 只做 LLM 分析（返回场景列表，不生图）----
app.post('/api/analyze-only', async (req, res) => {
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
        const { title, content, model, analyzeTemplate, maxScenes } = req.body;
        if (!content) return res.status(400).json({ error: '缺少章节内容' });
        const opts = {
            apiUrl: req.body.llmApiUrl || '',
            apiKey: req.body.llmApiKey || '',
            roles: req.body.roles || []
        };
        const scenes = await analyzeChapters(title, content, model, analyzeTemplate || '', parseInt(maxScenes) || 5, ctrl.signal, opts);
        res.json({ success: true, scenes });
    } catch (e) {
        if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') {
            console.log('⏹ 客户端断开，LLM 分析已取消');
            return;
        }
        console.error('分析失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ComfyUI 状态检测（后端代理，避免浏览器 CORS）
app.get('/api/comfyui-status', async (req, res) => {
    try {
        const base = (req.query.url || 'http://127.0.0.1:8188').replace(/\/+$/, '');
        const statsRes = await axios.get(`${base}/system_stats`, { timeout: 8000 });
        const device = statsRes.data?.devices?.[0]?.name || '未知';
        let queue = 0;
        try {
            const qRes = await axios.get(`${base}/queue`, { timeout: 5000 });
            queue = qRes.data?.queue_running?.length || 0;
        } catch (e) {}
        res.json({ success: true, device, queue });
    } catch (e) {
        res.json({ success: false, error: e.code === 'ECONNREFUSED' ? '连接被拒绝，ComfyUI 可能未启动' : e.message });
    }
});

// 测试 RunningHub 生图
app.post('/api/test-runninghub', async (req, res) => {
    try {
        const { apiKey, workflowId, posNode, posField, negNode, seedNode } = req.body;
        if (!apiKey || !workflowId) return res.json({ success: false, error: '缺少 API Key 或 Workflow ID' });
        const r = await generateRunningHubImage({
            prompt: 'a beautiful landscape, sunset, mountains, digital art, high quality',
            negative_prompt: '',
            apiKey, workflowId, posNodeId: posNode, posField: posField, negNodeId: negNode, seedNodeId: seedNode
        });
        res.json({ success: true, image: r.url });
    } catch (e) {
        console.error('RunningHub 测试失败:', e.message);
        res.json({ success: false, error: e.message });
    }
});

// ---- RunningHub 生图（国际站）----
async function generateRunningHubImage({ prompt, negative_prompt, apiKey, workflowId, posNodeId = '6', posField = 'text', negNodeId = '7', seedNodeId = '3' }) {
    if (!apiKey || !workflowId) throw new Error('RunningHub 需要 API Key 和 Workflow ID');
    const nodeInfoList = [
        { nodeId: String(posNodeId), fieldName: posField, fieldValue: prompt }
    ];
    if (negative_prompt) nodeInfoList.push({ nodeId: String(negNodeId), fieldName: 'text', fieldValue: negative_prompt });
    const mySeed = Math.floor(Math.random() * 1e15);
    nodeInfoList.push({ nodeId: String(seedNodeId), fieldName: 'seed', fieldValue: mySeed });

    // 1. 创建任务
    console.log('🚀 RunningHub 创建任务, workflow:', workflowId);
    const createRes = await axios.post('https://www.runninghub.ai/task/openapi/create', {
        apiKey, workflowId, nodeInfoList, addMetadata: false
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, timeout: 30000 });
    if (createRes.data.code !== 0) throw new Error('RunningHub: ' + (createRes.data.msg || '创建失败'));
    const taskId = createRes.data.data.taskId;
    console.log('📋 RunningHub 任务ID:', taskId);

    // 2. 轮询结果
    const maxWait = 300000;
    const interval = 3000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, interval));
        try {
            const outRes = await axios.get(`https://www.runninghub.ai/task/openapi/output?apiKey=${apiKey}&taskId=${taskId}`, { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 15000 });
            if (outRes.data.code === 0 && Array.isArray(outRes.data.data) && outRes.data.data.length > 0) {
                const url = outRes.data.data[0].fileUrl;
                console.log('✅ RunningHub 完成:', url);
                return { url, seed: mySeed };
            }
            const st = outRes.data.data?.taskStatus || '';
            if (st === 'FAILED' || outRes.data.code === 1001) throw new Error('RunningHub 任务失败');
        } catch (e) {
            if (e.message.includes('RunningHub 任务失败')) throw e;
            // 轮询接口可能还没就绪，继续等
        }
    }
    throw new Error('RunningHub 超时（5分钟）');
}

// ---- 单场景生图（前端逐张调用，可显示进度）----
app.post('/api/generate-scene', async (req, res) => {
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });
    try {
        const { prompt, negative_prompt, engine = 'comfyui', workflowConfig } = req.body;
        const pre = req.body.promptPrefix || '';
        const suf = req.body.promptSuffix || '';
        const wrapped = wrapPrompt(prompt, { promptPrefix: pre, promptSuffix: suf });
        logGen('/api/generate-scene', { prompt: wrapped, negative_prompt: negative_prompt || '', engine, workflowConfig, model: req.body.model, source: req.body.source || 'reader', novelId: req.body.novelId });
        let image, seed;
        if (engine === 'novelai') {
            const urls = await generateNovelAIImage({ ...req.body, prompt: wrapped, negative_prompt: negative_prompt || '' });
            image = urls[0];
        } else if (engine === 'grok') {
            const r = await generateGrokImage({
                prompt: wrapped,
                apiUrl: req.body.apiUrl,
                apiKey: req.body.apiKey,
                model: req.body.grokModel,
                width: req.body.width,
                height: req.body.height
            });
            image = r.url;
        } else if (engine === 'runninghub') {
            const r = await generateRunningHubImage({
                prompt: wrapped,
                negative_prompt: negative_prompt || '',
                apiKey: req.body.rhApiKey,
                workflowId: req.body.rhWorkflowId,
                posNodeId: req.body.rhPosNode || '6',
                posField: req.body.rhPosField || 'text',
                negNodeId: req.body.rhNegNode || '7',
                seedNodeId: req.body.rhSeedNode || '3'
            });
            image = r.url; seed = r.seed;
        } else {
            const r = await generateComfyImage(wrapped, negative_prompt || '', workflowConfig, {}, req.body.comfyUrl);
            image = r.url; seed = r.seed;
        }
        if (aborted) { console.log('⏹ 客户端已断开，跳过响应'); return; }
        logStat(engine, true);
        // 自动入库到插图库
        try {
            illustrations.unshift({
                id: uid(), chapterId: chapterId || null, novelId: req.body.novelId || null,
                scene: scene || '', prompt, anchor: anchor || '',
                engine, seed, image, createdAt: new Date().toISOString()
            });
            saveJson(ILLUS_FILE, illustrations);
        } catch (e) {}
        res.json({ success: true, image, seed });
    } catch (e) {
        logStat(req.body.engine || 'unknown', false);
        if (!res.headersSent) res.status(500).json({ error: e.message });
    }
});

// ---- 统计 ----
app.get('/api/stats', (req, res) => {
    res.json({ success: true, log: statsLog });
});
// 生图日志查询
app.get('/api/generation-log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json({ success: true, log: readGenLog(limit) });
});
app.delete('/api/stats', (req, res) => {
    statsLog = [];
    saveJson(STATS_FILE, statsLog);
    res.json({ success: true });
});

// ---- 一站式：分析 + 生图 + 入库（保留兼容）----
app.post('/api/analyze-and-generate', async (req, res) => {
    try {
        const { title, content, model, engine = 'comfyui', workflowConfig, chapterId, promptTemplate, negativeTemplate, analyzeTemplate } = req.body;
        if (!content) return res.status(400).json({ error: '缺少章节内容' });

        const scenes = await analyzeChapters(title, content, model, analyzeTemplate || '', 5, undefined, { roles: req.body.roles || [] });
        if (!scenes.length) return res.json({ success: true, scenes: [], message: '未找到适合配图的场景' });

        const results = [];
        const pre = req.body.promptPrefix || '';
        const suf = req.body.promptSuffix || '';
        for (const scene of scenes.slice(0, 5)) {
            try {
                let image, seed, usedEngine = engine;
                const wrapped = wrapPrompt(scene.prompt, { promptPrefix: pre, promptSuffix: suf });
                logGen('/api/analyze-and-generate', { prompt: wrapped, negative_prompt: scene.negative_prompt || '', engine, workflowConfig, model, source: req.body.source || 'illustrator' });
                if (engine === 'novelai') {
                    const urls = await generateNovelAIImage({ ...req.body, prompt: wrapped, negative_prompt: scene.negative_prompt || '' });
                    image = urls[0];
                } else if (engine === 'grok') {
                    const r = await generateGrokImage({
                        prompt: wrapped,
                        apiUrl: req.body.apiUrl,
                        apiKey: req.body.apiKey,
                        model: req.body.grokModel,
                        width: req.body.width,
                        height: req.body.height
                    });
                    image = r.url;
                } else {
                    const r = await generateComfyImage(wrapped, scene.negative_prompt || '', workflowConfig, { promptTemplate, negativeTemplate }, req.body.comfyUrl);
                    image = r.url; seed = r.seed;
                }
                // 自动入库
                const rec = {
                    id: uid(), chapterId: chapterId || null,
                    scene: scene.scene, prompt: scene.prompt, anchor: scene.anchor,
                    engine: usedEngine, seed, image, createdAt: new Date().toISOString()
                };
                illustrations.unshift(rec);
                results.push(rec);
            } catch (err) {
                console.error('单图生成失败:', err.message);
                results.push({ scene: scene.scene, prompt: scene.prompt, anchor: scene.anchor, error: err.message });
            }
        }
        saveJson(ILLUS_FILE, illustrations);
        res.json({ success: true, scenes: results, total: results.length, engine: engine === 'novelai' ? 'NovelAI' : engine === 'grok' ? 'Grok' : 'ComfyUI' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- LLM 模型列表 ----
app.post('/api/llm-models', async (req, res) => {
    try {
        const { apiUrl, apiKey } = req.body;
        if (!apiUrl || !apiKey) return res.json({ success: true, models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'deepseek-chat', 'deepseek-coder', 'claude-3-opus', 'claude-3-sonnet'], _default: true });
        // 智能拼接 models URL
        let modelsUrl;
        if (/\/chat\/completions$/.test(apiUrl)) {
            modelsUrl = apiUrl.replace(/\/chat\/completions$/, '/models');
        } else if (/\/v1$/.test(apiUrl)) {
            modelsUrl = apiUrl + '/models';
        } else if (/\/models$/.test(apiUrl)) {
            modelsUrl = apiUrl;
        } else {
            // 基础域名，补 /v1/models
            modelsUrl = apiUrl.replace(/\/+$/, '') + '/v1/models';
        }
        console.log('📥 获取模型列表:', modelsUrl);
        const r = await axios.get(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 });
        const models = Array.isArray(r.data?.data) ? r.data.data.map(m => m.id)
            : Array.isArray(r.data?.models) ? r.data.models
            : [];
        console.log('📥 获取到模型:', models);
        if (!models.length) {
            // 拿到 200 但没解析出模型 → 明确报错
            return res.json({ success: false, error: '接口返回 200 但未解析出模型列表（格式可能不兼容）', models: [], _default: false });
        }
        res.json({ success: true, models });
    } catch (e) {
        console.warn('📥 获取模型失败:', e.response ? `${e.response.status} ${e.response.statusText}` : e.message);
        const detail = e.response
            ? `HTTP ${e.response.status} ${e.response.statusText}${e.response.data && e.response.data.error ? ': ' + (typeof e.response.data.error === 'string' ? e.response.data.error : JSON.stringify(e.response.data.error).slice(0,200)) : ''}`
            : e.code === 'ECONNREFUSED' ? '连接被拒绝，确认 API 地址正确'
            : e.message;
        res.json({ success: false, error: detail, models: [], _default: false });
    }
});

// ============================================================
//  7. 启动
// ============================================================
app.listen(PORT, HOST, () => {
    const os = require('os');
    let lanIp = null;
    if (HOST === '0.0.0.0') {
        const ifaces = os.networkInterfaces();
        for (const name in ifaces) {
            for (const net of ifaces[name]) {
                if (net.family === 'IPv4' && !net.internal) { lanIp = net.address; break; }
            }
            if (lanIp) break;
        }
    }
    console.log('='.repeat(50));
    console.log('🚀 小说阅读器后端已启动');
    console.log('='.repeat(50));
    console.log(`💻 本机访问: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (lanIp) console.log(`📱 手机访问: http://${lanIp}:${PORT}`);
    console.log('-'.repeat(50));
    console.log(`LLM:       ${LLM_API_KEY ? '已配置 ✓' : '未配置（用模拟数据）'}`);
    console.log(`ComfyUI:   ${COMFYUI_URL}`);
    console.log(`NovelAI:   ${NOVELAI_API_KEY ? '已配置 ✓' : '未配置'}`);
    console.log(`章节库:    ${chapters.length} 条  插图库: ${illustrations.length} 条`);
    console.log('='.repeat(50));
});
