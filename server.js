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
const CHAPTERS_FILE = path.join(DATA_DIR, 'chapters.json');
const ILLUS_FILE = path.join(DATA_DIR, 'illustrations.json');

function loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}
function saveJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
let chapters = loadJson(CHAPTERS_FILE, []);
let illustrations = loadJson(ILLUS_FILE, []);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

async function callLlm(prompt, model) {
    const useModel = model || process.env.LLM_MODEL || 'gpt-4';
    const res = await axios.post(LLM_API_URL, {
        model: useModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
    }, {
        headers: { 'Authorization': `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60000
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

async function analyzeChapters(title, content, model, instruction = '', maxScenes = 5) {
    if (!LLM_API_KEY) {
        return [
            { scene: '主角站在山巅眺望远方', prompt: 'A lone figure standing on a mountain peak, overlooking a vast fantasy landscape, dramatic sunset lighting, epic scale, digital art, high quality', anchor: '主角站在山巅，目光投向远方' },
            { scene: '神秘的森林小径', prompt: 'A mysterious forest path with glowing mushrooms, ancient trees, ethereal atmosphere, fantasy art, detailed, beautiful lighting', anchor: '森林小径蜿蜒向前，不知通往何处' }
        ];
    }
    // 用户自定义的「绘图提示词生成规则」追加到系统指令
    const sysExtra = instruction ? `\n\n【附加规则：你生成的 prompt 字段必须遵守】\n${instruction}` : '';
    const chunks = chunkText(content || '');
    const allScenes = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const text = await callLlm(`${ANALYZE_SYSTEM}${sysExtra}\n\n章节标题：${title || ''}\n章节片段（${i + 1}/${chunks.length}）：\n${chunks[i]}`, model);
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

async function downloadComfyImage(image) {
    const url = `${COMFYUI_URL}/view?filename=${encodeURIComponent(image.filename)}&type=${image.type || 'output'}&subfolder=${encodeURIComponent(image.subfolder || '')}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const ext = (image.filename.split('.').pop() || 'png').toLowerCase();
    const localName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const localPath = path.join('images', 'comfy', localName);
    fs.writeFileSync(localPath, Buffer.from(resp.data));
    return `/images/comfy/${localName}`;
}

async function generateComfyImage(prompt, negativePrompt, workflowConfig, templates) {
    workflowConfig = workflowConfig || {};
    templates = templates || {};
    return enqueueComfy(async () => {
        // 应用提示词模板：{prompt} -> LLM 生成的场景提示词
        const finalPrompt = renderTemplate(templates.promptTemplate, { prompt, __fallback: prompt });
        const finalNeg = renderTemplate(templates.negativeTemplate, { prompt, __fallback: negativePrompt });
        const { workflow, seed } = buildComfyWorkflow(finalPrompt, finalNeg, workflowConfig);
        const submit = await axios.post(`${COMFYUI_URL}/prompt`, { prompt: workflow }, { timeout: 30000 });
        const promptId = submit.data.prompt_id;
        if (!promptId) throw new Error('ComfyUI 未返回 prompt_id');

        // 轮询结果
        const start = Date.now();
        while (Date.now() - start < 120000) {
            await new Promise(r => setTimeout(r, 1000));
            const hist = (await axios.get(`${COMFYUI_URL}/history/${promptId}`, { timeout: 10000 })).data;
            const entry = hist[promptId];
            if (!entry) continue;
            if (entry.status && entry.status.status_str === 'error') {
                const msgs = entry.status.messages || [];
                throw new Error('ComfyUI 工作流执行失败: ' + JSON.stringify(msgs).slice(0, 300));
            }
            const outputs = entry.outputs || {};
            for (const nodeId in outputs) {
                const imgs = outputs[nodeId].images;
                if (imgs && imgs.length) {
                    const localUrl = await downloadComfyImage(imgs[0]);
                    return { url: localUrl, seed, filename: imgs[0].filename };
                }
            }
        }
        throw new Error('ComfyUI 生成超时（120s），工作流可能过复杂或队列堵塞');
    });
}

// ============================================================
//  5. NovelAI 生图
// ============================================================
async function generateNovelAIImage(opts = {}) {
    let { prompt, negative_prompt, width = 832, height = 1216, steps = 28, sampler = 'k_euler_ancestral', scale = 5.0, model, seed, promptTemplate, negativeTemplate } = opts;
    if (!NOVELAI_API_KEY) throw new Error('未配置 NOVELAI_API_KEY');
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

    const resp = await axios.post(NOVELAI_API_URL, payload, {
        headers: { 'Authorization': `Bearer ${NOVELAI_API_KEY}`, 'Content-Type': 'application/json' },
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

    let resp;
    try {
        resp = await axios.post(url, {
            model: model || process.env.GROK_MODEL || 'grok-2-image-1212',
            prompt,
            n: 1,
            response_format: 'b64_json'
        }, {
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
app.get('/api/chapters', (req, res) => res.json({ success: true, chapters }));
app.post('/api/chapters', (req, res) => {
    const { id, title, content } = req.body;
    if (!content) return res.status(400).json({ error: '缺少章节内容' });
    if (id) {
        const idx = chapters.findIndex(c => c.id === id);
        if (idx >= 0) {
            chapters[idx] = { ...chapters[idx], title, content, updatedAt: new Date().toISOString() };
            saveJson(CHAPTERS_FILE, chapters);
            return res.json({ success: true, chapter: chapters[idx] });
        }
    }
    const chapter = { id: uid(), title: title || '未命名章节', content, createdAt: new Date().toISOString() };
    chapters.unshift(chapter);
    saveJson(CHAPTERS_FILE, chapters);
    res.json({ success: true, chapter });
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
    const list = req.query.chapterId
        ? illustrations.filter(i => i.chapterId === req.query.chapterId)
        : illustrations;
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
        const { prompt, negative_prompt, workflowConfig, promptTemplate, negativeTemplate } = req.body;
        if (!prompt) return res.status(400).json({ error: '缺少绘图提示词' });
        const img = await generateComfyImage(prompt, negative_prompt, workflowConfig, { promptTemplate, negativeTemplate });
        res.json({ success: true, image: img });
    } catch (e) {
        console.error('ComfyUI 生图失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---- NovelAI 生图 ----
app.post('/api/novelai-generate', async (req, res) => {
    try {
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
    try {
        const { title, content, model, analyzeTemplate, maxScenes } = req.body;
        if (!content) return res.status(400).json({ error: '缺少章节内容' });
        const scenes = await analyzeChapters(title, content, model, analyzeTemplate || '', parseInt(maxScenes) || 5);
        res.json({ success: true, scenes });
    } catch (e) {
        console.error('分析失败:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ---- 单场景生图（前端逐张调用，可显示进度）----
app.post('/api/generate-scene', async (req, res) => {
    try {
        const { prompt, negative_prompt, engine = 'comfyui', workflowConfig } = req.body;
        const pre = req.body.promptPrefix || '';
        const suf = req.body.promptSuffix || '';
        const wrapped = wrapPrompt(prompt, { promptPrefix: pre, promptSuffix: suf });
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
        } else {
            const r = await generateComfyImage(wrapped, negative_prompt || '', workflowConfig, {});
            image = r.url; seed = r.seed;
        }
        res.json({ success: true, image, seed });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- 一站式：分析 + 生图 + 入库（保留兼容）----
app.post('/api/analyze-and-generate', async (req, res) => {
    try {
        const { title, content, model, engine = 'comfyui', workflowConfig, chapterId, promptTemplate, negativeTemplate, analyzeTemplate } = req.body;
        if (!content) return res.status(400).json({ error: '缺少章节内容' });

        const scenes = await analyzeChapters(title, content, model, analyzeTemplate || '');
        if (!scenes.length) return res.json({ success: true, scenes: [], message: '未找到适合配图的场景' });

        const results = [];
        const pre = req.body.promptPrefix || '';
        const suf = req.body.promptSuffix || '';
        for (const scene of scenes.slice(0, 5)) {
            try {
                let image, seed, usedEngine = engine;
                const wrapped = wrapPrompt(scene.prompt, { promptPrefix: pre, promptSuffix: suf });
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
                    const r = await generateComfyImage(wrapped, scene.negative_prompt || '', workflowConfig, { promptTemplate, negativeTemplate });
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
        const modelsUrl = apiUrl.replace(/\/chat\/completions$/, '/models');
        const r = await axios.get(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 });
        const models = Array.isArray(r.data?.data) ? r.data.data.map(m => m.id)
            : Array.isArray(r.data?.models) ? r.data.models
            : [];
        res.json({ success: true, models: models.length ? models : ['gpt-4', 'gpt-3.5-turbo'], _default: !models.length });
    } catch {
        res.json({ success: true, models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'deepseek-chat', 'deepseek-coder'], _default: true });
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
