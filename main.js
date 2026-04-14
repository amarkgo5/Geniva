const { app, BrowserWindow, ipcMain, dialog, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const FormData = require('form-data');
const http = require('http');

// ─── Debug HTTP server — lets external scripts send tasks to Geniva ───
let _debugServer = null;
function startDebugServer() {
  _debugServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/task') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { message } = JSON.parse(body);
          addChat('user', message, null);
          broadcast('geniva-user-message', { text: message, imagePath: null });
          genivaThink(message, null);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ status: 'ok', message: 'Task sent' }));
        } catch(e) {
          res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ brain: _brain, chatHistory: _chatHistory.slice(-10), activityHistory: _activityHistory.slice(-10) }));
    } else if (req.method === 'GET' && req.url === '/chat') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(_chatHistory));
    } else if (req.method === 'GET' && req.url === '/perf') {
      const perf = await sampleSystemMetrics();
      computeThrottle(perf);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        gpu: { util: perf.gpuUtil, vramUsed: perf.gpuVramUsedMB, vramTotal: perf.gpuVramTotalMB },
        ram: { freeGB: perf.ramFreeGB, totalGB: perf.ramTotalGB },
        cpu: { util: perf.cpuUtil },
        throttle: { level: _perfState.throttleLevel, delay: _perfState.throttleDelayMs,
          gpuLayers: _perfState.currentGpuLayers, batch: _perfState.currentBatch, threads: _perfState.currentThreads }
      }));
    } else {
      res.writeHead(404); res.end('Not found');
    }
  });
  _debugServer.listen(3945, '127.0.0.1', () => console.log('[Geniva] Debug server on http://127.0.0.1:3945'));
}
const { execSync, spawn: cpSpawn } = require('child_process');

const MEMORY_PATH = path.join(__dirname, 'memory.json');
const os = require('os');
const HOME_DIR = os.homedir();
const DESKTOP_PATH = path.join(HOME_DIR, 'Desktop');

// ─── Brain mode: 'local' | 'claude-code' | 'claude-api' ───
let _brain = 'local';
let _abortController = null;
let fairyWin = null;
let panelWin = null;
let brainWin = null;

// ─── Broadcast to all windows ───
function _sendToWindows(channel, ...args) {
  for (const w of [fairyWin, panelWin, brainWin]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, ...args); } catch {}
    }
  }
}

// ─── Memory helpers ───
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_PATH)) return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf-8'));
  } catch {}
  return {};
}
function saveMemoryFile(data) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
function getSetting(key, fallback) {
  const mem = loadMemory();
  return mem[key] !== undefined ? mem[key] : fallback;
}

// Save user paths to memory on first run
(function initPaths() {
  const mem = loadMemory();
  if (!mem.home_dir || !mem.desktop_path) {
    mem.home_dir = HOME_DIR;
    mem.desktop_path = DESKTOP_PATH;
    mem.username = path.basename(HOME_DIR);
    saveMemoryFile(mem);
  }
})();

// ─── Tool implementations ───
const toolImpls = {
  read_file({ path: filePath }) {
    return fs.readFileSync(filePath, 'utf-8');
  },
  write_file({ path: filePath, content }) {
    // Protect Geniva's own files from being overwritten
    const protected_files = ['geniva-fairy.png', 'geniva-icon.png', 'geniva-body.png', 'wing-left.png', 'wing-right.png', 'main.js', 'index.html', 'panel.html'];
    const basename = path.basename(filePath);
    if (protected_files.includes(basename) && filePath.includes('Geniva')) {
      return `Error: Cannot overwrite protected Geniva file: ${basename}`;
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${filePath}`;
  },
  list_files({ directory }) {
    const items = fs.readdirSync(directory, { withFileTypes: true });
    return items.map(i => (i.isDirectory() ? '[DIR]  ' : '[FILE] ') + i.name).join('\n');
  },
  run_command({ command, cwd }) {
    try {
      return execSync(command, { encoding: 'utf-8', timeout: 60000, shell: true, cwd: cwd || undefined });
    } catch (e) {
      return `Error: ${e.message}\n${e.stderr || ''}`;
    }
  },
  async comfyui_generate(args) {
    // Accept workflow_json, prompt, or text as the input
    const workflow_json = args.workflow_json || args.prompt || args.text || args.description;
    if (!workflow_json) return 'Error: No prompt or workflow provided. Pass a text prompt or ComfyUI workflow JSON.';
    const url = getSetting('comfyui_url', 'http://127.0.0.1:8000');
    // Check if ComfyUI is online first
    try { await fetch(`${url}/system_stats`, { timeout: 3000 }); }
    catch { return 'ComfyUI is offline — start ComfyUI and try again.'; }

    // Free VRAM for ComfyUI — always unload Ollama model before generating
    _comfyActive = true;
    const vram = getVramUsage();
    broadcast('geniva-activity', `💾 VRAM at ${vram.pct}% — switching to CPU mode for ComfyUI generation`);
    await unloadOllamaModel();

    const checkpoint = getSetting('comfyui_checkpoint', 'sd_xl_base_1.0.safetensors');
    const imgWidth = getSetting('comfyui_width', 768);
    const imgHeight = getSetting('comfyui_height', 768);
    const imgSteps = getSetting('comfyui_steps', 20);

    // If workflow_json is a plain text description, build a basic txt2img workflow
    let wf;
    if (typeof workflow_json === 'string') {
      try {
        wf = JSON.parse(workflow_json);
      } catch {
        // Not valid JSON — treat as a text prompt and build a workflow
        console.log('[comfyui_generate] Got text prompt, building txt2img workflow:', workflow_json.substring(0, 100));
        const seed = Math.floor(Math.random() * 2147483647);
        wf = {
          "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
          "2": { class_type: "CLIPTextEncode", inputs: { text: workflow_json, clip: ["1", 1] } },
          "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry, low quality, distorted, deformed", clip: ["1", 1] } },
          "4": { class_type: "EmptyLatentImage", inputs: { width: imgWidth, height: imgHeight, batch_size: 1 } },
          "5": { class_type: "KSampler", inputs: { seed, steps: imgSteps, cfg: 7, sampler_name: "dpmpp_2m_sde", scheduler: "karras", denoise: 1.0, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
          "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
          "7": { class_type: "SaveImage", inputs: { filename_prefix: "geniva_gen", images: ["6", 0] } }
        };
      }
    } else if (typeof workflow_json === 'object' && workflow_json !== null) {
      wf = workflow_json;
    } else {
      return JSON.stringify({ error: 'workflow_json must be a ComfyUI workflow object or a text prompt description' });
    }

    // POST to /prompt
    const postBody = JSON.stringify({ prompt: wf });
    console.log('[comfyui_generate] Sending to', `${url}/prompt`, '- body length:', postBody.length);

    let res;
    try {
      res = await fetch(`${url}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postBody
      });
    } catch (e) {
      return JSON.stringify({ error: `Could not reach ComfyUI at ${url}: ${e.message}` });
    }

    const rawText = await res.text();
    console.log('[comfyui_generate] Response status:', res.status, '- raw:', rawText.substring(0, 300));

    let promptData;
    try {
      promptData = JSON.parse(rawText);
    } catch (e) {
      return JSON.stringify({ error: `ComfyUI returned invalid JSON (status ${res.status}): ${rawText.substring(0, 200)}` });
    }

    if (promptData.error) {
      return JSON.stringify({ error: `ComfyUI error: ${promptData.error}${promptData.node_errors ? ' — ' + JSON.stringify(promptData.node_errors).substring(0, 200) : ''}` });
    }

    const prompt_id = promptData.prompt_id;
    if (!prompt_id) {
      return JSON.stringify({ error: `ComfyUI did not return a prompt_id: ${rawText.substring(0, 200)}` });
    }

    // Poll /history until done
    for (let i = 0; i < 300; i++) {
      await sleep(1000);
      if (_abortController && _abortController.signal.aborted) return JSON.stringify({ error: 'Aborted' });
      // Show progress every 10s
      if (i % 10 === 0 && i > 0) {
        const v = getVramUsage();
        broadcast('geniva-activity', `🎨 Generating... (${i}s, VRAM: ${v.pct}%)`);
      }
      try {
        const hRes = await fetch(`${url}/history/${prompt_id}`);
        const hText = await hRes.text();
        let hist;
        try { hist = JSON.parse(hText); } catch { continue; }
        if (hist[prompt_id] && hist[prompt_id].outputs) {
          const outputs = hist[prompt_id].outputs;
          for (const nodeId of Object.keys(outputs)) {
            const images = outputs[nodeId].images;
            if (images && images.length > 0) {
              // Download the image from ComfyUI and copy to desktop
              const img = images[0];
              const filename = img.filename;
              const subfolder = img.subfolder || '';
              const desktopPath = path.join(DESKTOP_PATH, filename);
              try {
                const imgUrl = `${url}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
                const imgRes = await fetch(imgUrl);
                const imgBuf = Buffer.from(await imgRes.arrayBuffer());
                fs.writeFileSync(desktopPath, imgBuf);
                broadcast('geniva-activity', `📁 Saved image to ${desktopPath}`);
                _addWorkLog('generated_image', desktopPath);
                _comfyActive = false;
                return `Image generated successfully and saved to: ${desktopPath}`;
              } catch (dlErr) {
                // Couldn't download but image was generated
                _addWorkLog('generated_image', `ComfyUI output: ${filename}`);
                _comfyActive = false;
                return `Image generated in ComfyUI as ${filename} but could not copy to desktop: ${dlErr.message}`;
              }
            }
          }
          _comfyActive = false;
          return JSON.stringify({ prompt_id, outputs });
        }
      } catch {}
    }
    _comfyActive = false;
    return JSON.stringify({ error: 'Timed out waiting for ComfyUI generation (5 minutes)' });
  },
  async comfyui_upload_image({ image_path }) {
    const url = getSetting('comfyui_url', 'http://127.0.0.1:8000');
    try { await fetch(`${url}/system_stats`, { timeout: 3000 }); }
    catch { return 'ComfyUI is offline — start ComfyUI and try again.'; }
    const form = new FormData();
    form.append('image', fs.createReadStream(image_path), path.basename(image_path));
    form.append('overwrite', 'true');
    const res = await fetch(`${url}/upload/image`, { method: 'POST', body: form });
    return JSON.stringify(await res.json());
  },
  async analyze_image({ image_path, question }) {
    // Vision models need VRAM too — unload main model if VRAM is tight
    if (_brain === 'local') {
      const vram = getVramUsage();
      if (vram.pct > 60) {
        await unloadOllamaModel();
        await sleep(500);
      }
    }
    const imageData = fs.readFileSync(image_path);
    const base64 = imageData.toString('base64');
    const ext = path.extname(image_path).toLowerCase();
    const mediaMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mediaType = mediaMap[ext] || 'image/png';
    const q = question || 'Describe this image in detail.';
    if (_brain === 'local') {
      const ollamaUrl = getSetting('ollama_url', 'http://localhost:11434');
      const visionModel = getSetting('vision_model', 'llava');
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: visionModel, prompt: q, images: [base64], stream: false })
      });
      const data = await res.json();
      return data.response || JSON.stringify(data);
    } else {
      const apiKey = getSetting('anthropic_api_key', '');
      if (!apiKey) return 'Error: Anthropic API key not set.';
      const model = getSetting('claude_api_model', 'claude-sonnet-4-6');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: q }
        ]}]})
      });
      const data = await res.json();
      return (data.content || []).map(b => b.text || '').join('');
    }
  },
  async image_similarity({ image_path_a, image_path_b }) {
    const imgA = fs.readFileSync(image_path_a).toString('base64');
    const imgB = fs.readFileSync(image_path_b).toString('base64');
    const extA = path.extname(image_path_a).toLowerCase();
    const extB = path.extname(image_path_b).toLowerCase();
    const mediaMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const prompt = 'Compare these two images. Give a similarity score from 0 to 100 and list specific differences. Return ONLY valid JSON: {"score": <number>, "differences": ["<diff1>", "<diff2>"]}';
    if (_brain === 'local') {
      const ollamaUrl = getSetting('ollama_url', 'http://localhost:11434');
      const visionModel = getSetting('vision_model', 'llava');
      const res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: visionModel, prompt, images: [imgA, imgB], stream: false })
      });
      const data = await res.json();
      try { return JSON.parse(data.response); } catch { return { score: 0, differences: [data.response || 'Could not parse'] }; }
    } else {
      const apiKey = getSetting('anthropic_api_key', '');
      if (!apiKey) return { score: 0, differences: ['API key not set'] };
      const model = getSetting('claude_api_model', 'claude-sonnet-4-6');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaMap[extA] || 'image/png', data: imgA } },
          { type: 'image', source: { type: 'base64', media_type: mediaMap[extB] || 'image/png', data: imgB } },
          { type: 'text', text: prompt }
        ]}]})
      });
      const data = await res.json();
      const text = (data.content || []).map(b => b.text || '').join('');
      try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { score: 0, differences: [text] }; }
      catch { return { score: 0, differences: [text] }; }
    }
  },
  save_memory({ key, value }) {
    // Protect critical system keys from being overwritten by the agent
    const protectedKeys = ['home_dir', 'desktop_path', 'username', 'ollama_url', 'local_model', 'vision_model', 'comfyui_url', 'anthropic_api_key', 'claude_api_model', 'max_iterations', 'last_position', 'comfyui_checkpoint', 'pixel_art_lora'];
    if (protectedKeys.includes(key)) {
      return `Error: Cannot overwrite system setting "${key}". Use the Settings panel to change this.`;
    }
    const mem = loadMemory(); mem[key] = value; saveMemoryFile(mem);
    broadcast('memory-update', loadMemory());
    return `Saved memory: ${key} = ${String(value).substring(0, 100)}`;
  },
  get_memory({ key }) {
    const mem = loadMemory();
    return mem[key] !== undefined ? JSON.stringify(mem[key]) : `No memory found for key: ${key}`;
  },
  list_memory() { return JSON.stringify(loadMemory(), null, 2); },
  async web_search({ query }) {
    try {
      const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
      const data = await res.json();
      const parts = [];
      if (data.AbstractText) parts.push(data.AbstractText);
      if (data.Answer) parts.push(data.Answer);
      if (data.RelatedTopics) data.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) parts.push(t.Text); });
      return parts.length > 0 ? parts.join('\n\n') : 'No results found.';
    } catch (e) { return `Search error: ${e.message}`; }
  },
  restart_app() {
    // Relaunch using Electron's built-in relaunch
    app.relaunch();
    setTimeout(() => { app.exit(0); }, 300);
    return 'Restarting Geniva...';
  },
  async image_match_task({ reference_path, max_iterations }) {
    const maxIter = max_iterations || getSetting('max_image_match_iterations', 5);
    const threshold = getSetting('image_similarity_threshold', 85);
    const comfyUrl = getSetting('comfyui_url', 'http://127.0.0.1:8000');
    const checkpoint = getSetting('comfyui_checkpoint', 'sd_xl_base_1.0.safetensors');

    // Free VRAM for ComfyUI iterations — switch to CPU mode
    _comfyActive = true;
    const vram = getVramUsage();
    broadcast('geniva-activity', `💾 VRAM at ${vram.pct}% — switching to CPU mode for image matching`);
    await unloadOllamaModel();
    const pixelLora = getSetting('pixel_art_lora', 'pixel-art-xl.safetensors');
    const log = (msg) => broadcast('geniva-activity', msg);

    log('Analyzing reference image...');
    const analysis = await toolImpls.analyze_image({ image_path: reference_path, question: 'Describe this image in detail: subject, colors, art style, character features, background, composition.' });
    log('Reference analysis complete');
    log('Uploading reference to ComfyUI...');
    let uploadResult;
    try { uploadResult = JSON.parse(await toolImpls.comfyui_upload_image({ image_path: reference_path })); }
    catch (e) { return `Failed to upload reference: ${e.message}`; }
    const refFilename = uploadResult.name || path.basename(reference_path);

    let bestScore = 0, bestIteration = 0, bestImages = null;
    let promptText = analysis.substring(0, 300), loraStrength = 0.6, cfg = 5, steps = 25, ipWeight = 1.1;
    let negPrompt = 'blurry, low quality, distorted, deformed';

    for (let iter = 1; iter <= maxIter; iter++) {
      if (_abortController && _abortController.signal.aborted) break;
      log(`Iteration ${iter}/${maxIter} — Generating...`);
      const seed = Math.floor(Math.random() * 2147483647);
      const workflow = {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
        "2": { class_type: "LoraLoader", inputs: { lora_name: pixelLora, strength_model: loraStrength, strength_clip: loraStrength, model: ["1", 0], clip: ["1", 1] } },
        "3": { class_type: "CLIPTextEncode", inputs: { text: promptText, clip: ["2", 1] } },
        "4": { class_type: "CLIPTextEncode", inputs: { text: negPrompt, clip: ["2", 1] } },
        "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "6": { class_type: "LoadImage", inputs: { image: refFilename } },
        "7": { class_type: "PrepImageForClipVision", inputs: { interpolation: "LANCZOS", crop_position: "pad", sharpening: 0.5, image: ["6", 0] } },
        "8": { class_type: "IPAdapterModelLoader", inputs: { ipadapter_file: "ip-adapter-plus_sdxl_vit-h.safetensors" } },
        "9": { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip-vit-large-patch14-336.safetensors" } },
        "10": { class_type: "IPAdapterBatch", inputs: { weight: ipWeight, weight_type: "linear", start_at: 0.0, end_at: 0.8, embeds_scaling: "K+V", model: ["2", 0], ipadapter: ["8", 0], image: ["7", 0], clip_vision: ["9", 0] } },
        "11": { class_type: "KSampler", inputs: { seed, steps, cfg, sampler_name: "dpmpp_2m_sde", scheduler: "karras", denoise: 1.0, model: ["10", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0] } },
        "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["1", 2] } },
        "13": { class_type: "SaveImage", inputs: { filename_prefix: "geniva_match", images: ["12", 0] } }
      };
      let genResult;
      try { genResult = JSON.parse(await toolImpls.comfyui_generate({ workflow_json: workflow })); }
      catch (e) { log(`Generation error: ${e.message}`); continue; }
      if (genResult.error) { log(`ComfyUI error: ${genResult.error}`); continue; }
      const images = genResult.images;
      if (!images || images.length === 0) { log('No images returned'); continue; }
      let localResultPath;
      try {
        const imgRes = await fetch(`${comfyUrl}/view?filename=${images[0].filename}&subfolder=${images[0].subfolder || ''}&type=output`);
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        localResultPath = path.join(app.getPath('temp'), `geniva_match_${iter}.png`);
        fs.writeFileSync(localResultPath, imgBuf);
      } catch (e) { log(`Could not download result: ${e.message}`); continue; }
      log(`Comparing iteration ${iter} result...`);
      const sim = await toolImpls.image_similarity({ image_path_a: reference_path, image_path_b: localResultPath });
      const score = sim.score || 0; const diffs = sim.differences || [];
      log(`Iteration ${iter}/${maxIter} — Similarity: ${score}% — ${diffs[0] || 'N/A'}`);
      if (score > bestScore) { bestScore = score; bestIteration = iter; bestImages = images; }
      if (score >= threshold) { log(`Threshold reached!`); break; }
      if (iter < maxIter) {
        for (const diff of diffs) {
          const d = diff.toLowerCase();
          if (d.includes('color') || d.includes('dark') || d.includes('bright')) cfg = Math.max(3, Math.min(12, cfg + (d.includes('dark') ? -1 : 1)));
          if (d.includes('style') || d.includes('lora')) loraStrength = Math.max(0.3, Math.min(1.0, loraStrength + 0.1));
          if (d.includes('face') || d.includes('head') || d.includes('shape')) ipWeight = Math.min(1.5, ipWeight + 0.1);
          if (d.includes('blur') || d.includes('detail')) steps = Math.min(50, steps + 10);
          if (d.includes('background')) negPrompt += ', wrong background';
        }
        promptText = analysis.substring(0, 300) + '. ' + diffs.slice(0, 2).map(d => 'Fix: ' + d).join('. ');
      }
    }
    _comfyActive = false;
    if (bestScore > 0) { const mem = loadMemory(); mem.image_match_best_settings = { promptText, loraStrength, cfg, steps, ipWeight, negPrompt, bestScore, bestIteration }; saveMemoryFile(mem); }
    return `Best result: iteration ${bestIteration} with ${bestScore}% similarity. Images: ${JSON.stringify(bestImages)}. Settings saved to memory.`;
  }
};

// ─── Tool definitions — Anthropic format ───
const toolDefsAnthropic = [
  { name: 'read_file', description: 'Read a file and return its contents', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write content to a file', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] } },
  { name: 'list_files', description: 'List files and directories', input_schema: { type: 'object', properties: { directory: { type: 'string', description: 'Directory path' } }, required: ['directory'] } },
  { name: 'run_command', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string', description: 'Shell command' }, cwd: { type: 'string', description: 'Working directory (optional)' } }, required: ['command'] } },
  { name: 'comfyui_generate', description: 'Generate an image with ComfyUI. Pass a text prompt like "a green fairy" or a full ComfyUI workflow JSON', input_schema: { type: 'object', properties: { prompt: { type: 'string', description: 'Text description of the image to generate' } }, required: ['prompt'] } },
  { name: 'comfyui_upload_image', description: 'Upload image to ComfyUI server', input_schema: { type: 'object', properties: { image_path: { type: 'string' } }, required: ['image_path'] } },
  { name: 'analyze_image', description: 'Analyze an image using vision model', input_schema: { type: 'object', properties: { image_path: { type: 'string' }, question: { type: 'string' } }, required: ['image_path'] } },
  { name: 'image_similarity', description: 'Compare two images, return score 0-100 and differences', input_schema: { type: 'object', properties: { image_path_a: { type: 'string' }, image_path_b: { type: 'string' } }, required: ['image_path_a', 'image_path_b'] } },
  { name: 'save_memory', description: 'Save key/value to persistent memory', input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
  { name: 'get_memory', description: 'Get a value from memory by key', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'list_memory', description: 'List all memory contents', input_schema: { type: 'object', properties: {} } },
  { name: 'web_search', description: 'Search the web via DuckDuckGo', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'restart_app', description: 'Restart the Geniva app', input_schema: { type: 'object', properties: {} } },
  { name: 'image_match_task', description: 'Iteratively generate ComfyUI images to match a reference', input_schema: { type: 'object', properties: { reference_path: { type: 'string' }, max_iterations: { type: 'number' } }, required: ['reference_path'] } }
];

function toolDefsPlainText() {
  return toolDefsAnthropic.map(t => {
    const args = Object.entries(t.input_schema.properties || {}).map(([k, v]) => {
      const req = (t.input_schema.required || []).includes(k) ? ' (required)' : ' (optional)';
      return `    ${k}: ${v.type || 'any'}${req}${v.description ? ' — ' + v.description : ''}`;
    }).join('\n');
    return `- ${t.name}: ${t.description}\n${args}`;
  }).join('\n');
}

// ─── Active Learning System ───
const LEARNING_PATH = path.join(__dirname, 'learning.json');
const HISTORY_PATH = path.join(__dirname, 'history.json');

// ─── Persistent task history — remembers what she's done across sessions ───
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch {}
  return [];
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function addToHistory(task, result, toolsUsed, success) {
  const history = loadHistory();
  history.push({
    task: task.substring(0, 200),
    result: (result || '').substring(0, 300),
    tools: toolsUsed,
    success,
    brain: _brain,
    date: new Date().toISOString()
  });
  // Keep last 100 tasks
  if (history.length > 100) history.splice(0, history.length - 100);
  saveHistory(history);
}

function buildHistoryContext() {
  const history = loadHistory();
  if (history.length === 0) return '';
  const recent = history.slice(-10);
  let ctx = '\n\nRECENT TASK HISTORY (you did these previously):';
  for (const h of recent) {
    const date = new Date(h.date).toLocaleDateString();
    ctx += `\n- [${date}] "${h.task.substring(0, 80)}" → ${h.success ? 'success' : 'failed'}${h.tools && h.tools.length ? ' (used: ' + h.tools.join(', ') + ')' : ''}`;
    if (h.result) ctx += ` | Result: ${h.result.substring(0, 100)}`;
  }
  return ctx;
}

function loadLearning() {
  try {
    if (fs.existsSync(LEARNING_PATH)) return JSON.parse(fs.readFileSync(LEARNING_PATH, 'utf-8'));
  } catch {}
  return { task_patterns: [], thinking_shortcuts: [], user_preferences: [], skill_level: 0, total_tasks: 0, successful_tasks: 0 };
}

function saveLearning(data) {
  fs.writeFileSync(LEARNING_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function categorizeTask(task) {
  const t = task.toLowerCase();
  // More specific categories checked first
  if (t.includes('comfy') && t.includes('generate')) return 'comfyui';
  if (t.includes('image') && (t.includes('generat') || t.includes('creat'))) return 'image_gen';
  if (t.includes('image') || t.includes('photo') || t.includes('picture') || t.includes('screenshot')) return 'image';
  if (t.includes('search') || t.includes('look up') || t.includes('find info')) return 'search';
  if (t.includes('code') || t.includes('script') || t.includes('program') || t.includes('function')) return 'code';
  if (t.includes('file') || t.includes('read') || t.includes('write') || t.includes('create') || t.includes('save')) return 'file';
  if (t.includes('install') || t.includes('run') || t.includes('execute') || t.includes('command')) return 'system';
  if (t.includes('remember') || t.includes('memory') || t.includes('forget')) return 'memory';
  return 'general';
}

function learnFromTask(task, steps, success, errorMsg) {
  const learning = loadLearning();
  learning.total_tasks = (learning.total_tasks || 0) + 1;
  if (success) learning.successful_tasks = (learning.successful_tasks || 0) + 1;
  learning.skill_level = Math.round((learning.successful_tasks / Math.max(learning.total_tasks, 1)) * 100);

  const taskType = categorizeTask(task);
  const toolsUsed = steps.filter(s => s.tool).map(s => s.tool);
  // Deduplicate consecutive identical tool calls
  const dedupedTools = toolsUsed.filter((t, i) => i === 0 || t !== toolsUsed[i - 1]);

  const pattern = {
    type: taskType,
    task_summary: task.substring(0, 100),
    tools_used: dedupedTools,
    step_count: steps.length,
    success,
    error: errorMsg || null,
    timestamp: Date.now()
  };

  learning.task_patterns = (learning.task_patterns || []);
  learning.task_patterns.push(pattern);
  if (learning.task_patterns.length > 50) learning.task_patterns = learning.task_patterns.slice(-50);

  // Build thinking shortcuts — only from successful multi-step tasks
  if (success && dedupedTools.length > 0) {
    const shortcut = {
      type: taskType,
      tools: dedupedTools,
      success_count: 1,
      learned_at: Date.now()
    };
    learning.thinking_shortcuts = (learning.thinking_shortcuts || []);
    // Update existing or add new
    const existing = learning.thinking_shortcuts.find(s => s.type === taskType && JSON.stringify(s.tools) === JSON.stringify(dedupedTools));
    if (existing) {
      existing.success_count = (existing.success_count || 1) + 1;
      existing.learned_at = Date.now();
    } else {
      learning.thinking_shortcuts.push(shortcut);
      if (learning.thinking_shortcuts.length > 30) learning.thinking_shortcuts = learning.thinking_shortcuts.slice(-30);
    }
  }

  // Learn from errors
  if (!success && errorMsg) {
    learning.error_lessons = (learning.error_lessons || []);
    // Don't duplicate similar errors
    const similar = learning.error_lessons.find(e => e.task_type === taskType && e.error.substring(0, 50) === errorMsg.substring(0, 50));
    if (!similar) {
      learning.error_lessons.push({ task_type: taskType, error: errorMsg.substring(0, 200), timestamp: Date.now() });
      if (learning.error_lessons.length > 20) learning.error_lessons = learning.error_lessons.slice(-20);
    }
  }

  // Auto-detect user preferences from task patterns
  learning.user_preferences = learning.user_preferences || [];
  const recentPatterns = learning.task_patterns.slice(-20);
  // If user frequently uses a specific tool type, note it
  const toolFreq = {};
  for (const p of recentPatterns) {
    for (const t of p.tools_used || []) { toolFreq[t] = (toolFreq[t] || 0) + 1; }
  }
  const topTool = Object.entries(toolFreq).sort((a, b) => b[1] - a[1])[0];
  if (topTool && topTool[1] >= 5) {
    const pref = `User frequently uses ${topTool[0]} (${topTool[1]} times in last 20 tasks)`;
    if (!learning.user_preferences.includes(pref)) {
      learning.user_preferences = learning.user_preferences.filter(p => !p.startsWith('User frequently uses'));
      learning.user_preferences.push(pref);
    }
  }
  // Cap preferences
  if (learning.user_preferences.length > 10) learning.user_preferences = learning.user_preferences.slice(-10);

  saveLearning(learning);
  broadcast('geniva-activity', `📚 Learned (skill: ${learning.skill_level}%, tasks: ${learning.total_tasks})`);
  return learning;
}

function buildLearningContext(taskMessage) {
  const learning = loadLearning();
  if (!learning.total_tasks) return '';

  let ctx = `\n\nLEARNING (${learning.total_tasks} tasks, ${learning.skill_level}% success):`;

  // Find relevant shortcuts for THIS task type
  if (learning.thinking_shortcuts && learning.thinking_shortcuts.length > 0 && taskMessage) {
    const taskLower = (taskMessage || '').toLowerCase();
    const taskType = taskLower.includes('image') ? 'image' :
      taskLower.includes('file') || taskLower.includes('read') || taskLower.includes('write') ? 'file' :
      taskLower.includes('code') || taskLower.includes('script') ? 'code' :
      taskLower.includes('search') || taskLower.includes('find') ? 'search' :
      taskLower.includes('comfy') || taskLower.includes('generate') ? 'comfyui' : null;

    // Show shortcuts matching this task type first, then general ones
    const relevant = learning.thinking_shortcuts.filter(s => s.type === taskType);
    const general = learning.thinking_shortcuts.filter(s => s.type !== taskType).slice(-3);
    const shortcuts = [...relevant, ...general].slice(-6);
    if (shortcuts.length > 0) {
      ctx += '\nPROVEN PATTERNS (use these — they worked before):';
      for (const s of shortcuts) {
        ctx += `\n- ${s.type} → ${s.tools.join(' → ')}`;
      }
    }
  }

  // Add error lessons — but only recent and relevant
  if (learning.error_lessons && learning.error_lessons.length > 0) {
    const recent = learning.error_lessons.slice(-5);
    ctx += '\nAVOID THESE MISTAKES:';
    for (const e of recent) {
      ctx += `\n- ${e.task_type}: ${e.error.substring(0, 100)}`;
    }
  }

  // User preferences
  if (learning.user_preferences && learning.user_preferences.length > 0) {
    ctx += '\nUSER PREFERENCES:';
    for (const p of learning.user_preferences) {
      ctx += `\n- ${p}`;
    }
  }

  // Only add recent history (not all of it) to save context
  const history = loadHistory();
  if (history.length > 0) {
    const recent = history.slice(-5);
    ctx += '\nRECENT TASKS:';
    for (const h of recent) {
      ctx += `\n- "${h.task.substring(0, 60)}" → ${h.success ? 'OK' : 'FAIL'}`;
    }
  }

  return ctx + buildWorkLogContext();
}

const SYSTEM_PROMPT = `You are Geniva, a personal AI agent and assistant. You complete tasks autonomously using tools. You think step by step, use tools, observe results, and keep going until done.

APPROACH:
1. PLAN — For multi-step tasks, decide your steps before acting. For simple tasks (greetings, questions), respond directly.
2. ACT — Execute one tool at a time. Read the result before deciding the next step.
3. VERIFY — After completing work, check it succeeded (read the file you wrote, test the command output).
4. RESPOND — Give a clear, concise final answer. Don't repeat what tools already showed.

RULES:
- Be decisive. Pick the best tool and use it immediately.
- If you've done a similar task before, use the pattern you learned.
- Never guess file paths — use list_files to discover them first.
- Always use absolute paths. Never use relative paths.
- If a tool fails, read the error, adjust, and retry ONCE. If it fails again, tell the user why.
- Never overwrite Geniva's own files (main.js, index.html, panel.html, images).

USER PATHS — always use these exact paths:
- Home directory: ${HOME_DIR}
- Desktop: ${DESKTOP_PATH}
- Documents: ${path.join(HOME_DIR, 'Documents')}
- Brain Vault (Obsidian knowledge base): ${path.join(HOME_DIR, 'Documents', 'BrainVault')}
- Username: ${path.basename(HOME_DIR)}

KNOWLEDGE BASE — You have an Obsidian vault at the Brain Vault path above. It contains project notes, session logs, architecture docs, tool references, and decision logs. When asked about projects, tools, or past work, ALWAYS check the Brain Vault first:
1. list_files on the Brain Vault directory and its subdirectories (Projects/, Tools/, Sessions/, Architecture/, etc.)
2. read_file on relevant .md files to find the information
Key project notes: Projects/YettiPaintStudio/YettiPaintStudio.md, Projects/Geniva/Geniva.md, Projects/DragonTD/DragonTD.md`;

function localSystemPrompt() {
  const mem = loadMemory();
  // Only include non-sensitive, non-settings memory keys
  const settingsKeys = ['ollama_url','local_model','vision_model','comfyui_url','anthropic_api_key','claude_api_model','max_iterations','max_image_match_iterations','image_similarity_threshold','comfyui_checkpoint','pixel_art_lora','home_dir','desktop_path','username','last_position','image_match_best_settings'];
  const userMemory = {};
  for (const [k, v] of Object.entries(mem)) {
    if (!settingsKeys.includes(k)) userMemory[k] = v;
  }
  const memStr = Object.keys(userMemory).length > 0 ? JSON.stringify(userMemory) : '(empty)';

  const learningCtx = buildLearningContext(_currentTaskMessage || '');
  return `You are Geniva, an AI assistant and autonomous agent. You complete tasks using tools, then report results clearly.

TOOLS:
${toolDefsPlainText()}

OUTPUT FORMAT — reply with EXACTLY one JSON object per message, nothing else:

To use a tool:
{"tool": "tool_name", "args": {"key": "value"}}

To respond to the user:
{"response": "your answer here"}

EXAMPLES:
User: "list what's on my desktop"
You: {"tool": "list_files", "args": {"directory": "${DESKTOP_PATH}"}}
Tool returns: "[FILE] notes.txt\\n[DIR] projects"
You: {"response": "Your desktop has: notes.txt and a projects folder."}

User: "write a hello world python script"
You: {"tool": "write_file", "args": {"path": "${DESKTOP_PATH}/hello.py", "content": "print('Hello World!')"}}
Tool returns: "Wrote 22 bytes to ..."
You: {"tool": "run_command", "args": {"command": "python \\"${DESKTOP_PATH}/hello.py\\""}}
Tool returns: "Hello World!"
You: {"response": "Done! Created hello.py on your desktop and ran it — output was 'Hello World!'"}

User: "hey" or "hello"
You: {"response": "Hey! What can I help you with?"}

RULES:
- Output ONLY valid JSON. No text before or after the JSON.
- One tool call per reply. Wait for the result, then decide next step.
- For multi-step tasks: plan mentally, then execute step by step.
- After completing work, VERIFY it worked (read the file, check the output).
- When DONE, give a clear summary of what you did. End with a follow-up question.
- If a tool fails, read the error carefully. Adjust and retry ONCE. If it fails again, explain why.
- For Python scripts: write_file a .py then run_command to execute it.
- NEVER output anything that isn't valid JSON.
- NEVER explain what you're about to do — just do it.
- NEVER call the same tool with the same arguments more than twice.

PATHS:
- Home: ${HOME_DIR}
- Desktop: ${DESKTOP_PATH}
- Documents: ${path.join(HOME_DIR, 'Documents')}
- Brain Vault: ${path.join(HOME_DIR, 'Documents', 'BrainVault')}
- Username: ${path.basename(HOME_DIR)}
- Geniva app: ${__dirname}

KNOWLEDGE BASE — You have an Obsidian vault at the Brain Vault path above. It contains project notes, session logs, architecture docs, and decision logs about all the user's projects. When asked about projects, tools, or past work, ALWAYS check the Brain Vault first:
1. Use list_files on the Brain Vault directory to see what's there
2. Use read_file on relevant .md files to find the information
Key project notes you should check:
- ${path.join(HOME_DIR, 'Documents', 'BrainVault', 'Projects', 'YettiPaintStudio', 'YettiPaintStudio.md')}
- ${path.join(HOME_DIR, 'Documents', 'BrainVault', 'Projects', 'Geniva', 'Geniva.md')}
- ${path.join(HOME_DIR, 'Documents', 'BrainVault', 'Projects', 'DragonTD', 'DragonTD.md')}
- ${path.join(HOME_DIR, 'Documents', 'BrainVault', 'Decisions Log.md')}

SOFTWARE:
- Python 3.11 + Pillow — use for image processing tasks
- Node.js — use for JS/web tasks
- NO ImageMagick — never use "convert" or "magick" commands
- NEVER overwrite Geniva app files (main.js, index.html, panel.html)

MEMORY (things you've learned about the user):
${memStr}${learningCtx}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Context management utilities ───
function estimateTokens(text) {
  // Rough estimate: ~4 chars per token for English, ~3 for code/JSON
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    total += 4; // overhead per message
  }
  return total;
}

// Trim conversation messages to fit within a token budget, keeping system + recent
function trimMessages(messages, maxTokens) {
  if (messages.length <= 2) return messages;
  const systemMsg = messages[0]; // always keep system prompt
  const systemTokens = estimateTokens(systemMsg.content);
  const budget = maxTokens - systemTokens - 200; // reserve 200 for safety

  // Build from the end (most recent first)
  const kept = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    const msg = messages[i];
    const cost = estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)) + 4;
    if (used + cost > budget) break;
    kept.unshift(msg);
    used += cost;
  }

  // If we dropped messages, add a summary marker
  const dropped = messages.length - 1 - kept.length;
  if (dropped > 0) {
    kept.unshift({ role: 'user', content: `[${dropped} earlier messages trimmed for context. Focus on the current task.]` });
  }

  return [systemMsg, ...kept];
}

// ─── VRAM Management — dynamic GPU/CPU switching for Ollama ───
// Ollama runs on GPU for fast Geniva responses (~35s vs ~90s on CPU).
// Before ComfyUI generation, we fully unload the model from VRAM.
// After generation, the model auto-reloads with GPU layers on next chat.
// The adaptive throttle scales GPU layers based on available VRAM.
let _comfyActive = false; // true while ComfyUI is generating — forces CPU-only mode

async function unloadOllamaModel() {
  // Send keep_alive=0 to force-unload the model from VRAM immediately
  try {
    const ollamaUrl = getSetting('ollama_url', 'http://localhost:11434');
    const model = getSetting('local_model', 'geniva-brain');
    await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 })
    });
    broadcast('geniva-activity', '💾 Unloaded model from VRAM');
  } catch {} // Ollama might not be running

  // Wait for VRAM to actually free up (Ollama doesn't release instantly)
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const v = getVramUsage();
    // ComfyUI model is ~8GB, so if VRAM is under 9GB the Ollama model is gone
    if (v.used < 9500) return;
  }
}

function getVramUsage() {
  try {
    const raw = execSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits', { encoding: 'utf-8', timeout: 3000, shell: true }).trim();
    const [used, total] = raw.split(',').map(s => parseInt(s.trim()));
    return { used: used || 0, total: total || 16376, pct: Math.round((used || 0) / (total || 16376) * 100) };
  } catch { return { used: 0, total: 16376, pct: 0 }; }
}

// NOTE: We do NOT throttle ComfyUI/python processes — other apps (YettiPaintStudio etc.)
// share the same ComfyUI instance. Geniva manages VRAM by unloading its own Ollama model
// before ComfyUI calls, which is enough to prevent VRAM conflicts.

// ─── Adaptive Performance Monitor ───
// Samples GPU, RAM, and CPU to detect system pressure and adjust Geniva's intensity in real-time.
const _perfState = {
  gpuUtil: 0,          // 0-100%
  gpuVramUsedMB: 0,
  gpuVramTotalMB: 16376,
  ramFreeGB: 64,
  ramTotalGB: 64,
  cpuUtil: 0,          // 0-100%
  lastSample: 0,
  // Adaptive parameters — adjusted up/down based on system load
  currentGpuLayers: null,   // null = use setting, number = overridden
  currentBatch: null,
  currentThreads: null,
  throttleLevel: 0,         // 0=none, 1=light, 2=moderate, 3=heavy
  throttleDelayMs: 0,       // delay injected between agent steps
  lastBroadcast: 0,
};

// ─── CPU usage tracking via os.cpus() snapshots (zero-cost, no subprocess) ───
let _cpuPrev = null;
function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const type in c.times) total += c.times[type];
    idle += c.times.idle;
  }
  if (!_cpuPrev) { _cpuPrev = { idle, total }; return 0; }
  const dIdle = idle - _cpuPrev.idle;
  const dTotal = total - _cpuPrev.total;
  _cpuPrev = { idle, total };
  return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
}

// Sample system metrics — uses os module (instant) + nvidia-smi (async spawn, ~80ms)
async function sampleSystemMetrics() {
  const now = Date.now();
  // Don't sample more than once per 3 seconds
  if (now - _perfState.lastSample < 3000) return _perfState;

  // RAM — instant via Node os module (0ms, no subprocess)
  _perfState.ramFreeGB = Math.round(os.freemem() / 1073741824 * 10) / 10;
  _perfState.ramTotalGB = Math.round(os.totalmem() / 1073741824 * 10) / 10;

  // CPU — instant via os.cpus() diff (0ms, no subprocess)
  _perfState.cpuUtil = getCpuUsage();

  // GPU — nvidia-smi via async spawn (~80ms, non-blocking)
  try {
    const gpuData = await new Promise((resolve, reject) => {
      let out = '';
      const proc = cpSpawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 2000 });
      proc.stdout.on('data', d => out += d.toString());
      proc.on('close', () => resolve(out.trim()));
      proc.on('error', reject);
    });
    const [gpuUtil, vramUsed, vramTotal] = gpuData.split(',').map(s => parseFloat(s.trim()));
    _perfState.gpuUtil = gpuUtil || 0;
    _perfState.gpuVramUsedMB = vramUsed || 0;
    _perfState.gpuVramTotalMB = vramTotal || 16376;
  } catch {}

  _perfState.lastSample = now;
  return _perfState;
}

// Decide throttle level based on current metrics
function computeThrottle(perf) {
  const baseGpuLayers = getSetting('num_gpu_layers', 20);
  const baseBatch = getSetting('num_batch', 256);
  const baseThreads = Math.max(2, Math.min(8, (require('os').cpus().length) - 4));

  // ─── ComfyUI active: force CPU-only mode, no GPU layers at all ───
  if (_comfyActive) {
    _perfState.currentGpuLayers = 0;
    _perfState.currentBatch = baseBatch;
    _perfState.currentThreads = baseThreads;
    _perfState.throttleDelayMs = 0;
    if (_perfState.throttleLevel !== 99) {
      _perfState.throttleLevel = 99;
      broadcast('geniva-activity', '🎨 ComfyUI generating — Geniva on CPU mode (GPU reserved for image gen)');
    }
    return { gpuLayers: 0, batch: baseBatch, threads: baseThreads, delayMs: 0, level: 99 };
  }

  const gpuPressure = perf.gpuUtil > 85;
  const vramPressure = perf.gpuVramUsedMB > perf.gpuVramTotalMB * 0.85;
  const vramHigh = perf.gpuVramUsedMB > perf.gpuVramTotalMB * 0.65; // ComfyUI is probably loaded
  const ramPressure = perf.ramFreeGB < 4;
  const cpuPressure = perf.cpuUtil > 80;

  let level = 0;
  if (gpuPressure || vramPressure) level++;
  if (ramPressure) level++;
  if (cpuPressure) level++;
  if (gpuPressure && cpuPressure) level = Math.max(level, 3); // both saturated = heavy

  let gpuLayers, batch, threads, delayMs;

  switch (level) {
    case 0: // System is fine — use full settings (GPU for speed!)
      gpuLayers = baseGpuLayers;
      batch = baseBatch;
      threads = baseThreads;
      delayMs = 0;
      break;
    case 1: // Light pressure — small reduction
      gpuLayers = Math.max(10, baseGpuLayers - 5);
      batch = Math.max(64, baseBatch - 64);
      threads = Math.max(2, baseThreads - 1);
      delayMs = 500;
      break;
    case 2: // Moderate — significant pullback
      gpuLayers = Math.max(5, Math.floor(baseGpuLayers * 0.6));
      batch = Math.max(32, Math.floor(baseBatch / 2));
      threads = Math.max(2, Math.floor(baseThreads / 2));
      delayMs = 1500;
      break;
    case 3: // Heavy — minimal GPU, max breathing room
      gpuLayers = 0;
      batch = 32;
      threads = 2;
      delayMs = 3000;
      break;
  }

  // ─── VRAM coexistence: if something else (ComfyUI, game, etc.) is using significant VRAM,
  //     reduce GPU layers proportionally so Ollama doesn't OOM or fight for VRAM ───
  if (vramHigh && level < 2) {
    const vramFreeMB = perf.gpuVramTotalMB - perf.gpuVramUsedMB;
    // Only use GPU layers that fit comfortably — rough estimate: ~200MB per layer
    // Reserve 4GB minimum for ComfyUI generation headroom
    const reserveMB = 4000;
    const availableForOllama = Math.max(0, vramFreeMB - reserveMB);
    const maxLayersForVram = Math.floor(availableForOllama / 200);
    if (maxLayersForVram < gpuLayers) {
      gpuLayers = Math.max(0, maxLayersForVram);
      if (level === 0) delayMs = 300; // tiny delay since we're partially on CPU now
      broadcast('geniva-activity', `💾 VRAM busy (${perf.gpuVramUsedMB}MB) — ${gpuLayers} GPU layers (reserving ${reserveMB}MB for ComfyUI)`);
    }
  }

  _perfState.currentGpuLayers = gpuLayers;
  _perfState.currentBatch = batch;
  _perfState.currentThreads = threads;
  _perfState.throttleDelayMs = delayMs;

  // Only broadcast throttle changes (not every sample)
  if (level !== _perfState.throttleLevel) {
    _perfState.throttleLevel = level;
    const labels = ['normal', 'light throttle', 'moderate throttle', 'heavy throttle'];
    const detail = `GPU:${perf.gpuUtil}% VRAM:${perf.gpuVramUsedMB}MB RAM-free:${perf.ramFreeGB}GB CPU:${perf.cpuUtil}%`;
    broadcast('geniva-activity', `⚡ Performance: ${labels[level]} (${detail})`);
  }

  return { gpuLayers, batch, threads, delayMs, level };
}

// Call this between agent steps to throttle if needed
async function adaptiveThrottle() {
  const perf = await sampleSystemMetrics();
  const throttle = computeThrottle(perf);

  if (throttle.delayMs > 0) {
    await sleep(throttle.delayMs);
  }
  return throttle;
}

// ─── Brain: Ollama (Local) — streaming with stuck detection ───
async function callOllama(messages) {
  const ollamaUrl = getSetting('ollama_url', 'http://localhost:11434');
  const model = getSetting('local_model', 'geniva-brain');

  // ─── Adaptive performance — sample system and adjust parameters ───
  const perf = await sampleSystemMetrics();
  const throttle = computeThrottle(perf);

  const numGpuLayers = throttle.gpuLayers;
  const numCtx = getSetting('num_ctx', 4096);
  const numPredict = getSetting('num_predict', 1024);
  const numBatch = throttle.batch;
  const numThreads = throttle.threads;
  const keepAlive = getSetting('keep_alive', '5m');

  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: true,
      keep_alive: keepAlive,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: numPredict,
        num_ctx: numCtx,
        num_gpu: numGpuLayers,
        num_batch: numBatch,
        num_thread: numThreads
      }
    })
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

  // Lower Ollama runner priority (non-blocking — don't freeze the UI for 700ms)
  try {
    const p = cpSpawn('wmic', ['process', 'where', "name='ollama_llama_server.exe'", 'call', 'setpriority', 'below normal'], { shell: true, stdio: 'ignore' });
    p.on('error', () => {});
  } catch {}

  // Read stream — if no new token arrives for 30 seconds, consider it stuck
  // 5 min stall timeout for first call (model loading), 30s after first token
  const STALL_TIMEOUT_INITIAL = 300000;
  const STALL_TIMEOUT_ACTIVE = 30000;
  let fullContent = '';
  let lastTokenTime = Date.now();
  let done = false;

  const reader = res.body;
  const chunks = [];

  // Heartbeat — show waiting status until first token arrives
  let firstToken = false;
  const heartbeat = setInterval(() => {
    if (!firstToken && !done) {
      const secs = Math.round((Date.now() - lastTokenTime)/1000);
      broadcast('geniva-activity', `⏳ Loading model... (${secs}s) — first response is slow, after that it's faster`);
    }
  }, 2000);

  return new Promise((resolve, reject) => {
    let buffer = '';
    let stallCheck = setInterval(() => {
      if (done) { clearInterval(stallCheck); return; }
      const timeout = firstToken ? STALL_TIMEOUT_ACTIVE : STALL_TIMEOUT_INITIAL;
      if (Date.now() - lastTokenTime > timeout) {
        clearInterval(stallCheck);
        clearInterval(heartbeat);
        done = true;
        // Model stalled — return whatever we have so far
        if (fullContent.trim()) {
          console.log('[callOllama] Model stalled after', fullContent.length, 'chars — returning partial');
          broadcast('geniva-activity', '⚠️ Model stalled — using partial response');
          resolve({ message: { role: 'assistant', content: fullContent } });
        } else {
          reject(new Error('Model stopped responding — no tokens received for 30 seconds'));
        }
        try { reader.destroy(); } catch {}
      }
    }, 5000);

    reader.on('data', (chunk) => {
      lastTokenTime = Date.now();
      if (!firstToken) {
        firstToken = true;
        broadcast('geniva-activity', '⚡ Model responding — thinking...');
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          // deepseek-r1 sends reasoning in 'thinking' field, answer in 'content'
          if (obj.message) {
            if (obj.message.thinking) {
              broadcast('geniva-stream-local', obj.message.thinking);
            }
            if (obj.message.content) {
              fullContent += obj.message.content;
              broadcast('geniva-stream-local', obj.message.content);
            }
          }
          if (obj.done) {
            done = true;
            clearInterval(stallCheck);
            clearInterval(heartbeat);
            broadcast('geniva-activity', `✅ Generated ${fullContent.length} chars`);
            resolve({ message: { role: 'assistant', content: fullContent } });
          }
        } catch {}
      }
    });

    reader.on('end', () => {
      done = true;
      clearInterval(stallCheck);
      clearInterval(heartbeat);
      resolve({ message: { role: 'assistant', content: fullContent } });
    });

    reader.on('error', (err) => {
      done = true;
      clearInterval(stallCheck);
      clearInterval(heartbeat);
      reject(err);
    });
  });
}

// ─── Brain: Claude Code (stream-json) ───
function callClaudeCodeStream(fullPrompt, callbacks, imagePaths) {
  return new Promise((resolve, reject) => {
    let buffer = '', stderr = '', finalResult = '';
    const args = [
      '--print', '--dangerously-skip-permissions',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages'
    ];
    if (imagePaths && imagePaths.length > 0) {
      for (const img of imagePaths) args.push('--image', img);
    }
    const proc = cpSpawn('claude', args, { shell: true, timeout: 180000 });
    proc.stdout.on('data', d => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'system' && evt.subtype === 'init' && callbacks.onInit) callbacks.onInit();
          if (evt.type === 'stream_event' && evt.event) {
            const se = evt.event;
            if (se.type === 'content_block_delta' && se.delta && se.delta.text && callbacks.onText) callbacks.onText(se.delta.text);
          }
          if (evt.type === 'result') finalResult = evt.result || '';
        } catch {}
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 && !finalResult) reject(new Error(`Claude Code exited ${code}: ${stderr}`));
      else resolve(finalResult);
    });
    proc.on('error', reject);
    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

// ─── Brain: Claude API ───
async function callClaudeAPI(messages) {
  const apiKey = getSetting('anthropic_api_key', '');
  if (!apiKey) throw new Error('Anthropic API key not set.');
  const model = getSetting('claude_api_model', 'claude-sonnet-4-6');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM_PROMPT + buildLearningContext(_currentTaskMessage || ''), tools: toolDefsAnthropic, messages })
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  return await res.json();
}

// ─── Execute a tool (broadcasts to all windows) ───
async function executeTool(name, args) {
  const icons = { read_file: '📁', write_file: '📁', list_files: '📁', run_command: '📁',
    comfyui_generate: '🎨', comfyui_upload_image: '🎨', analyze_image: '🔍',
    image_similarity: '🔍', save_memory: '🧠', get_memory: '🧠', list_memory: '🧠',
    web_search: '🔍', image_match_task: '🔄' };
  const icon = icons[name] || '🧠';
  broadcast('geniva-activity', `${icon} ${name}(${JSON.stringify(args || {}).substring(0, 120)})`);
  broadcast('brain-fire-context', `${name} ${JSON.stringify(args || {}).substring(0, 200)}`);
  let result;
  try {
    result = toolImpls[name] ? await toolImpls[name](args || {}) : `Unknown tool: ${name}`;
    // ComfyUI auto-retry on error
    if (name.startsWith('comfyui_') && typeof result === 'string' && (result.includes('Error') || result.includes('offline'))) {
      for (let retry = 1; retry <= 5; retry++) {
        if (_abortController && _abortController.signal.aborted) break;
        broadcast('geniva-activity', `🔄 ComfyUI retry ${retry}/5 — waiting 3s...`);
        await sleep(3000);
        try { result = await toolImpls[name](args || {}); } catch (e2) { result = `Tool error: ${e2.message}`; }
        if (!result.includes('Error') && !result.includes('offline')) break;
      }
    }
  } catch (e) {
    result = `Tool error: ${e.message}`;
    broadcast('geniva-activity', `❌ ${name}: ${e.message}`);
  }
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
  broadcast('geniva-activity', `✅ ${name} done`);
  // Track step for learning
  _currentTaskSteps.push({ tool: name, args: args, success: !resultStr.startsWith('Tool error') });
  // Save to work log — remember file paths and outputs
  if (name === 'write_file' && args.path) {
    _addWorkLog('created_file', args.path);
  }
  if (name === 'comfyui_generate' && resultStr.includes('images')) {
    _addWorkLog('generated_image', resultStr.substring(0, 200));
  }
  if (name === 'run_command' && args.command) {
    _addWorkLog('ran_command', args.command.substring(0, 100) + ' → ' + resultStr.substring(0, 100));
  }
  return resultStr;
}

// ─── Chat history (shared between fairy + panel) ───
let _chatHistory = [];
let _activityHistory = [];

function addChat(role, text, imagePath) {
  const entry = { role, text, time: Date.now() };
  if (imagePath) entry.imagePath = imagePath;
  _chatHistory.push(entry);
  if (_chatHistory.length > 200) _chatHistory = _chatHistory.slice(-200);
}

function addActivity(text) {
  const entry = { text, time: Date.now() };
  _activityHistory.push(entry);
  if (_activityHistory.length > 100) _activityHistory = _activityHistory.slice(-100);
}

// Clean ALL JSON from chat display
function cleanChat(text) {
  if (!text || typeof text !== 'string') return '';
  return String(text)
    .replace(/\{[\s\S]*?"tool"[\s\S]*?\}/g, '')
    .replace(/\{[\s\S]*?"workflow"[\s\S]*?\}/g, '')
    .replace(/\{[\s\S]*?"response"[\s\S]*?\}/g, (m) => {
      try { return JSON.parse(m).response || ''; } catch { return m; }
    })
    .replace(/\\n|\\t|\\"/g, ' ')
    .replace(/^\s*[\{\}\\]+\s*$/gm, '')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

function broadcast(channel, ...args) {
  if (channel === 'geniva-reply') {
    const cleaned = cleanChat(args[0]);
    if (!cleaned) return; // Skip empty/JSON-only messages
    addChat('geniva', cleaned);
    _sendToWindows(channel, cleaned);
    return;
  }
  if (channel === 'geniva-activity') addActivity(args[0]);
  _sendToWindows(channel, ...args);
}

// ─── Work log — remembers what files/images she created ───
const WORKLOG_PATH = path.join(__dirname, 'worklog.json');
const BRAIN_VAULT_PATH = 'C:\\Users\\amark\\Documents\\BrainVault';

function loadWorkLog() {
  try { if (fs.existsSync(WORKLOG_PATH)) return JSON.parse(fs.readFileSync(WORKLOG_PATH, 'utf-8')); } catch {}
  return [];
}
function _addWorkLog(type, detail) {
  const log = loadWorkLog();
  log.push({ type, detail, date: new Date().toISOString() });
  if (log.length > 100) log.splice(0, log.length - 100);
  fs.writeFileSync(WORKLOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// ─── Brain Vault Auto-Journal ───
// Writes task summaries to Obsidian after each completed Geniva task.
// Daily journal file: Sessions/YYYY-MM-DD Geniva Journal.md
// Also updates Decisions Log for errors/learnings.

function _brainVaultJournal(userMessage, reply, tools, success, errorMsg) {
  try {
    const now = new Date();
    // Use local time for date (not UTC) so journal files match the user's day
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const journalDir = path.join(BRAIN_VAULT_PATH, 'Sessions');
    const journalFile = path.join(journalDir, `${dateStr} Geniva Journal.md`);

    // Create journal file with header if it doesn't exist
    if (!fs.existsSync(journalFile)) {
      const header = `# ${dateStr}: Geniva Activity Journal\n**Auto-generated** by Geniva's Brain Vault integration.\n\n---\n\n`;
      fs.writeFileSync(journalFile, header, 'utf-8');
    }

    // Build the entry
    const toolList = tools && tools.length > 0 ? tools.join(', ') : 'none';
    const status = success ? 'OK' : 'FAILED';
    const replySnippet = reply ? reply.substring(0, 200).replace(/\n/g, ' ') : '(no reply)';

    let entry = `### ${timeStr} — ${status}\n`;
    entry += `**Asked:** ${userMessage.substring(0, 300)}\n`;
    if (tools && tools.length > 0) entry += `**Tools:** ${toolList}\n`;
    entry += `**Result:** ${replySnippet}`;
    if (replySnippet.length < (reply || '').length) entry += '...';
    entry += '\n';
    if (!success && errorMsg) entry += `**Error:** ${errorMsg.substring(0, 200)}\n`;
    entry += '\n---\n\n';

    fs.appendFileSync(journalFile, entry, 'utf-8');

    // If a ComfyUI image was generated, log extra detail
    if (tools && tools.some(t => t === 'comfyui_generate') && reply && reply.includes('saved to')) {
      const imgMatch = reply.match(/saved to:\s*(.+?)(?:\s|$)/);
      if (imgMatch) {
        const imgNote = `> Image saved: \`${imgMatch[1]}\`\n\n`;
        // Insert before the last ---
        const content = fs.readFileSync(journalFile, 'utf-8');
        const lastDash = content.lastIndexOf('---');
        if (lastDash > 0) {
          const updated = content.substring(0, lastDash) + imgNote + content.substring(lastDash);
          fs.writeFileSync(journalFile, updated, 'utf-8');
        }
      }
    }

    // Log errors to Decisions Log as lessons learned
    if (!success && errorMsg && errorMsg.length > 10) {
      _brainVaultLogDecision(dateStr, userMessage, errorMsg);
    }
  } catch (e) {
    console.log('[BrainVault] Journal write failed:', e.message);
  }
}

function _brainVaultLogDecision(dateStr, task, errorMsg) {
  try {
    const decisionsFile = path.join(BRAIN_VAULT_PATH, 'Decisions Log.md');
    if (!fs.existsSync(decisionsFile)) return;

    // Only log unique errors — don't spam the decisions log
    const content = fs.readFileSync(decisionsFile, 'utf-8');
    const errorKey = errorMsg.substring(0, 60);
    if (content.includes(errorKey)) return; // Already logged

    const entry = `\n## ${dateStr}: Geniva Error — ${task.substring(0, 80)}\n` +
      `**What happened:** ${errorMsg.substring(0, 300)}\n` +
      `**Context:** Auto-logged by Geniva after task failure.\n\n`;

    // Insert before ## Tags line
    const tagsIdx = content.indexOf('## Tags');
    if (tagsIdx > 0) {
      const updated = content.substring(0, tagsIdx) + entry + content.substring(tagsIdx);
      fs.writeFileSync(decisionsFile, updated, 'utf-8');
    }
  } catch (e) {
    console.log('[BrainVault] Decision log write failed:', e.message);
  }
}
function buildWorkLogContext() {
  const log = loadWorkLog();
  if (log.length === 0) return '';
  const recent = log.slice(-15);
  let ctx = '\n\nRECENT WORK (files and images you created):';
  for (const entry of recent) {
    const date = new Date(entry.date).toLocaleDateString();
    ctx += `\n- [${date}] ${entry.type}: ${entry.detail.substring(0, 150)}`;
  }
  return ctx;
}

// ─── Persistent conversations (survive across tasks in same session) ───
let _localSessionMessages = null;
let _apiSessionHistory = []; // Claude API conversation history

// ─── Task tracking for active learning ───
let _currentTaskSteps = [];
let _currentTaskMessage = '';

// ─── Main agent dispatcher with auto-fallback ───
async function genivaThink(userMessage, imagePath) {
  _abortController = new AbortController();
  _currentTaskSteps = [];
  _currentTaskMessage = userMessage;
  broadcast('geniva-thinking', true);
  broadcast('brain-fire-context', userMessage);
  let success = true;
  let errorMsg = null;
  let usedFallback = false;

  try {
    if (_brain === 'local') await agentLoopLocal(userMessage, imagePath);
    else if (_brain === 'claude-code') await agentLoopClaudeCode(userMessage, imagePath);
    else if (_brain === 'claude-api') await agentLoopClaudeAPI(userMessage, imagePath);
  } catch (e) {
    // ─── Auto-fallback: if local brain fails, try Claude API ───
    if (_brain === 'local' && getSetting('anthropic_api_key', '')) {
      broadcast('geniva-activity', `⚠️ Local model failed: ${e.message}`);
      broadcast('geniva-activity', '🔄 Auto-falling back to Claude API...');
      try {
        _abortController = new AbortController(); // reset abort
        await agentLoopClaudeAPI(userMessage, imagePath);
        usedFallback = true;
        broadcast('geniva-activity', '✅ Completed via Claude API fallback');
      } catch (e2) {
        success = false;
        errorMsg = `Local failed: ${e.message}. API fallback also failed: ${e2.message}`;
        broadcast('geniva-reply', `Both local model and Claude API failed. Local error: ${e.message}. API error: ${e2.message}`);
      }
    } else if (_brain === 'claude-api' || _brain === 'claude-code') {
      // Try the other Claude option
      const alt = _brain === 'claude-api' ? 'claude-code' : 'claude-api';
      const canFallback = alt === 'claude-api' ? getSetting('anthropic_api_key', '') : true;
      if (canFallback) {
        broadcast('geniva-activity', `⚠️ ${_brain} failed: ${e.message}`);
        broadcast('geniva-activity', `🔄 Trying ${alt}...`);
        try {
          _abortController = new AbortController();
          if (alt === 'claude-api') await agentLoopClaudeAPI(userMessage, imagePath);
          else await agentLoopClaudeCode(userMessage, imagePath);
          usedFallback = true;
        } catch (e2) {
          success = false;
          errorMsg = e2.message;
          broadcast('geniva-reply', `Error: ${e.message}. Fallback also failed: ${e2.message}`);
        }
      } else {
        success = false;
        errorMsg = e.message;
        broadcast('geniva-reply', `Error: ${e.message}`);
      }
    } else {
      success = false;
      errorMsg = e.message;
      broadcast('geniva-reply', `Error: ${e.message}`);
    }
  }

  // Active learning — learn from this task
  learnFromTask(_currentTaskMessage, _currentTaskSteps, success, errorMsg);
  const lastReply = _chatHistory.filter(c => c.role === 'geniva').slice(-1)[0];
  const toolsUsed = _currentTaskSteps.map(s => s.tool);
  addToHistory(_currentTaskMessage, lastReply ? lastReply.text : errorMsg, toolsUsed, success);

  // Auto-journal to Brain Vault (Obsidian)
  _brainVaultJournal(_currentTaskMessage, lastReply ? lastReply.text : errorMsg, toolsUsed, success, errorMsg);

  _abortController = null;
  broadcast('geniva-thinking', false);
  broadcast('geniva-done', true);
  broadcast('memory-update', loadMemory());
  if (usedFallback) {
    broadcast('geniva-activity', `ℹ️ Used fallback brain for this task`);
  }
}

// ─── Parse JSON from local model response (robust) ───
function parseLocalResponse(raw) {
  if (!raw || !raw.trim()) return null;
  let parsed = null;

  // Strategy 1: Direct JSON parse (fast path)
  try { parsed = JSON.parse(raw.trim()); } catch {}

  // Strategy 2: Extract first JSON object from text
  if (!parsed) {
    try {
      // Find the outermost { ... } — handle nested braces
      const start = raw.indexOf('{');
      if (start >= 0) {
        let depth = 0, end = -1, inStr = false, escape = false;
        for (let i = start; i < raw.length; i++) {
          const c = raw[i];
          if (escape) { escape = false; continue; }
          if (c === '\\') { escape = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (c === '{') depth++;
          if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > start) {
          parsed = JSON.parse(raw.substring(start, end + 1));
        }
      }
    } catch {}
  }

  // Strategy 3: Fix common typos and retry
  if (!parsed) {
    let fixed = raw
      .replace(/"ool"/g, '"tool"')
      .replace(/"ags"/g, '"args"')
      .replace(/[\x00-\x1f]/g, ' ') // strip control chars
      .replace(/,\s*}/g, '}')        // trailing commas
      .replace(/,\s*]/g, ']');       // trailing commas in arrays
    try {
      const start = fixed.indexOf('{');
      const end = fixed.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(fixed.substring(start, end + 1));
    } catch {}
  }

  // Strategy 4: Regex extraction for specific tool patterns
  if (!parsed) {
    const toolMatch = raw.match(/"tool"\s*:\s*"(\w+)"/);
    if (toolMatch) {
      const tool = toolMatch[1];
      if (tool === 'write_file') {
        const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/);
        const ci = raw.indexOf('"content"');
        if (pathMatch && ci > -1) {
          let start = raw.indexOf('"', ci + 10);
          if (start > -1) {
            start++;
            let end = start;
            while (end < raw.length) {
              if (raw[end] === '"' && raw[end - 1] !== '\\') {
                const after = raw.substring(end + 1).trim();
                if (after.startsWith('}') || after.startsWith('}}')) break;
              }
              end++;
            }
            if (end > start) {
              const content = raw.substring(start, end).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
              parsed = { tool, args: { path: pathMatch[1], content } };
            }
          }
        }
      } else if (tool === 'run_command') {
        const cm = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (cm) parsed = { tool, args: { command: cm[1].replace(/\\"/g, '"') } };
      } else {
        // Generic: extract all "key": "value" pairs from around the tool match
        const args = {};
        const argPattern = /"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = argPattern.exec(raw)) !== null) {
          if (m[1] !== 'tool') args[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n');
        }
        parsed = { tool, args };
      }
    }
  }

  // Validate: must have either 'tool' or 'response'
  if (parsed && !parsed.tool && parsed.response === undefined) return null;
  // Validate tool name exists
  if (parsed && parsed.tool && !toolImpls[parsed.tool] && parsed.tool !== 'restart_app') {
    // Try fuzzy match
    const candidates = Object.keys(toolImpls);
    const close = candidates.find(c => c.includes(parsed.tool) || parsed.tool.includes(c));
    if (close) parsed.tool = close;
  }

  return parsed;
}

// ─── Local (Ollama) loop — persistent session, runs until done or stopped ───
const MAX_LOCAL_ITERATIONS = 25;
const LOCAL_CONTEXT_BUDGET = 6000; // token budget for context (conservative for small models)

async function agentLoopLocal(userMessage, imagePath) {
  // Reuse session messages so she remembers previous tasks
  if (!_localSessionMessages) {
    _localSessionMessages = [{ role: 'system', content: localSystemPrompt() }];
  } else {
    // Refresh system prompt with latest memory/learning each task
    _localSessionMessages[0] = { role: 'system', content: localSystemPrompt() };
  }

  if (imagePath) {
    const base64 = fs.readFileSync(imagePath).toString('base64');
    _localSessionMessages.push({ role: 'user', content: userMessage, images: [base64] });
  } else {
    _localSessionMessages.push({ role: 'user', content: userMessage });
  }

  // Smart context trimming — token-aware instead of naive message count
  _localSessionMessages = trimMessages(_localSessionMessages, LOCAL_CONTEXT_BUDGET);

  // ─── Stuck detection state ───
  const recentToolCalls = []; // track last 6 tool calls for oscillation detection
  let iterations = 0;
  let consecutiveErrors = 0;

  while (iterations < MAX_LOCAL_ITERATIONS) {
    iterations++;
    if (_abortController && _abortController.signal.aborted) { broadcast('geniva-reply', 'Task stopped.'); break; }

    // Adaptive throttle — pause between steps if system is under pressure
    if (iterations > 1) await adaptiveThrottle();

    broadcast('geniva-activity', `🧠 Thinking... (step ${iterations})`);

    let resp;
    try {
      resp = await callOllama(_localSessionMessages);
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 2 || e.name === 'AbortError') {
        // Will trigger fallback in genivaThink if applicable
        throw e;
      }
      broadcast('geniva-activity', `⚠️ Model error, retrying... (${e.message})`);
      await sleep(2000);
      continue;
    }

    const raw = (resp.message && resp.message.content) || '';
    if (!raw.trim()) { broadcast('geniva-reply', 'No response from local model.'); break; }

    const parsed = parseLocalResponse(raw);

    // TOOL CALL — execute with smart stuck detection
    if (parsed && parsed.tool) {
      const callSig = `${parsed.tool}:${JSON.stringify(parsed.args || {})}`;

      // ─── Oscillation & repeat detection ───
      recentToolCalls.push(callSig);
      if (recentToolCalls.length > 6) recentToolCalls.shift();

      // Check exact repeat (same tool+args 3x)
      const repeatCount = recentToolCalls.filter(c => c === callSig).length;
      if (repeatCount >= 3) {
        broadcast('geniva-activity', '⚠️ Stuck — same tool called 3 times with same args');
        _localSessionMessages.push({ role: 'user', content: '[SYSTEM] You are repeating the same tool call. Stop and give the user your best answer with {"response": "..."}' });
        continue;
      }

      // Check A→B→A oscillation pattern
      if (recentToolCalls.length >= 4) {
        const last4 = recentToolCalls.slice(-4);
        if (last4[0] === last4[2] && last4[1] === last4[3]) {
          broadcast('geniva-activity', '⚠️ Stuck — oscillating between two tools');
          _localSessionMessages.push({ role: 'user', content: '[SYSTEM] You are going back and forth between tools. This approach is not working. Try a different strategy or give the user your best answer with {"response": "..."}' });
          continue;
        }
      }

      if (toolImpls[parsed.tool]) {
        broadcast('geniva-activity', `🔧 Using ${parsed.tool}...`);
        _localSessionMessages.push({ role: 'assistant', content: JSON.stringify(parsed) });
        const result = await executeTool(parsed.tool, parsed.args || {});
        // Truncate very long results to save context
        const truncResult = result.length > 2000 ? result.substring(0, 2000) + '\n... (truncated, ' + result.length + ' chars total)' : result;
        _localSessionMessages.push({ role: 'user', content: `Tool "${parsed.tool}" returned:\n${truncResult}\n\nContinue working or give final answer.` });
        // Re-trim context after adding new messages
        _localSessionMessages = trimMessages(_localSessionMessages, LOCAL_CONTEXT_BUDGET);
        continue;
      } else {
        broadcast('geniva-activity', `❌ Unknown tool: ${parsed.tool}`);
        _localSessionMessages.push({ role: 'assistant', content: raw });
        _localSessionMessages.push({ role: 'user', content: `Tool "${parsed.tool}" does not exist. Available tools: ${Object.keys(toolImpls).join(', ')}. Pick the correct tool.` });
        continue;
      }
    }

    // RESPONSE — check if it's code that should be executed
    if (parsed && parsed.response !== undefined) {
      const respText = String(parsed.response);
      if (respText.match(/^(from |import |def |class |#!)/m) && respText.includes('\n')) {
        broadcast('geniva-activity', '🔧 Auto-executing code...');
        const scriptPath = path.join(HOME_DIR, 'Desktop', 'geniva_temp_script.py');
        try {
          fs.writeFileSync(scriptPath, respText);
          const result = execSync(`python "${scriptPath}"`, { encoding: 'utf-8', timeout: 60000, shell: true });
          broadcast('geniva-activity', '✅ Script executed');
          try { fs.unlinkSync(scriptPath); } catch {}
          _localSessionMessages.push({ role: 'assistant', content: raw });
          _localSessionMessages.push({ role: 'user', content: `Code ran. Output:\n${result || '(done)'}\n\nTell the user what happened with {"response": "..."}.` });
          continue;
        } catch (e) {
          broadcast('geniva-activity', `❌ Script error`);
          try { fs.unlinkSync(scriptPath); } catch {}
          _localSessionMessages.push({ role: 'assistant', content: raw });
          _localSessionMessages.push({ role: 'user', content: `Code error: ${e.stderr || e.message}\n\nFix and retry, or explain the error with {"response": "..."}.` });
          continue;
        }
      }

      // Show the response
      broadcast('geniva-reply', respText);
      _localSessionMessages.push({ role: 'assistant', content: raw });

      // Check if she should continue — but only if the task seems incomplete
      if (!respText.trim().endsWith('?') && iterations < 3) {
        _localSessionMessages.push({ role: 'user', content: '[SYSTEM] Is the task fully complete? If there is more to do, continue. If done, say {"response": "ready"}' });
        let checkResp;
        try { checkResp = await callOllama(_localSessionMessages); } catch { _localSessionMessages.pop(); break; }
        const checkRaw = (checkResp.message && checkResp.message.content) || '';
        const checkParsed = parseLocalResponse(checkRaw);
        if (checkParsed && checkParsed.tool) {
          _localSessionMessages.pop(); // Remove system check
          _localSessionMessages.push({ role: 'assistant', content: checkRaw });
          const result = await executeTool(checkParsed.tool, checkParsed.args || {});
          _localSessionMessages.push({ role: 'user', content: `Tool "${checkParsed.tool}" returned:\n${result}\n\nContinue.` });
          continue;
        }
        _localSessionMessages.pop(); // Remove system check
      }
      break;
    }

    // NOT VALID JSON — try to recover by asking for proper format
    if (iterations <= 2) {
      broadcast('geniva-activity', '⚠️ Invalid format, asking for retry...');
      _localSessionMessages.push({ role: 'assistant', content: raw });
      _localSessionMessages.push({ role: 'user', content: '[SYSTEM] Your response was not valid JSON. You MUST reply with ONLY a JSON object: either {"tool": "name", "args": {...}} or {"response": "text"}. Try again.' });
      continue;
    }
    // After 2 format failures, just show whatever we got
    broadcast('geniva-reply', raw.trim());
    _localSessionMessages.push({ role: 'assistant', content: raw });
    break;
  }

  if (iterations >= MAX_LOCAL_ITERATIONS) {
    broadcast('geniva-activity', `⚠️ Hit max iterations (${MAX_LOCAL_ITERATIONS})`);
    broadcast('geniva-reply', 'I hit my step limit for this task. Here\'s what I accomplished so far — let me know if you want me to continue.');
  }
}

// ─── Claude Code loop (streaming) ───
async function agentLoopClaudeCode(userMessage, imagePath) {
  broadcast('geniva-activity', '🧠 Sending to Claude Code...');

  // Build prompt with conversation history so Claude remembers previous messages
  let prompt = '';
  const recentChat = _chatHistory.slice(-20); // Last 20 messages
  if (recentChat.length > 1) {
    prompt += 'Previous conversation:\n';
    for (const msg of recentChat.slice(0, -1)) { // Exclude current message (it's already the last one)
      prompt += `${msg.role === 'user' ? 'User' : 'Geniva'}: ${msg.text}\n`;
    }
    prompt += '\nCurrent request:\n';
  }
  prompt += userMessage;
  const imgArgs = imagePath ? [imagePath] : [];
  let started = false;
  const response = await callClaudeCodeStream(prompt, {
    onInit() { broadcast('geniva-activity', '🧠 Claude is thinking...'); },
    onText(chunk) {
      if (!started) { started = true; broadcast('geniva-stream-start', {}); }
      broadcast('geniva-stream-chunk', chunk);
    }
  }, imgArgs);
  if (started) broadcast('geniva-stream-end', {});
  else if (response) broadcast('geniva-reply', response);
  broadcast('geniva-activity', '✅ Claude Code responded');
}

// ─── Claude API loop — runs until done or stopped, with persistent history ───
async function agentLoopClaudeAPI(userMessage, imagePath) {
  // Build current message with optional image
  let userContent;
  if (imagePath) {
    const base64 = fs.readFileSync(imagePath).toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png';
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: mt, data: base64 } },
      { type: 'text', text: userMessage }
    ];
  } else {
    userContent = userMessage;
  }

  // Inject conversation history for continuity (keep last 10 exchanges)
  const messages = [];
  const recentHistory = _apiSessionHistory.slice(-20); // last 20 messages (10 exchanges)
  for (const h of recentHistory) {
    messages.push(h);
  }
  messages.push({ role: 'user', content: userContent });

  let iterations = 0;
  while (iterations < MAX_LOCAL_ITERATIONS) {
    iterations++;
    if (_abortController && _abortController.signal.aborted) { broadcast('geniva-reply', 'Task stopped.'); break; }
    broadcast('geniva-activity', `🧠 Thinking... (step ${iterations})`);
    const response = await callClaudeAPI(messages);
    let hasToolUse = false; const toolResults = [];
    for (const block of (response.content || [])) {
      if (block.type === 'text' && block.text) broadcast('geniva-reply', block.text);
      if (block.type === 'tool_use') {
        hasToolUse = true;
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }
    if (!hasToolUse || response.stop_reason === 'end_turn') {
      // Save to session history for future tasks
      _apiSessionHistory.push({ role: 'user', content: userContent });
      const textBlocks = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (textBlocks) _apiSessionHistory.push({ role: 'assistant', content: textBlocks });
      // Trim history to keep manageable
      if (_apiSessionHistory.length > 30) _apiSessionHistory = _apiSessionHistory.slice(-20);
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }
}

// ─── Connectivity ───
async function checkOllama() {
  try {
    const url = getSetting('ollama_url', 'http://localhost:11434');
    const res = await fetch(`${url}/api/tags`, { timeout: 3000 });
    if (res.ok) return { online: true, models: (await res.json()).models || [] };
  } catch {} return { online: false, models: [] };
}
async function checkComfyUI() {
  try {
    const url = getSetting('comfyui_url', 'http://127.0.0.1:8000');
    const res = await fetch(`${url}/system_stats`, { timeout: 3000 });
    if (res.ok) return { online: true };
  } catch {} return { online: false };
}

// ─── IPC handlers ───
ipcMain.handle('geniva-task', async (event, { message, imagePath }) => {
  addChat('user', message, imagePath || null);
  broadcast('geniva-user-message', { text: message, imagePath: imagePath || null });
  genivaThink(message, imagePath || null);
});
ipcMain.on('stop-task', () => { if (_abortController) _abortController.abort(); });
ipcMain.on('set-brain', (event, mode) => {
  if (['local', 'claude-code', 'claude-api'].includes(mode)) {
    _brain = mode;
    broadcast('brain-changed', mode);
  }
});
ipcMain.on('get-brain', (event) => { event.returnValue = _brain; });
ipcMain.handle('check-connections', async () => {
  const ollama = await checkOllama();
  const comfy = await checkComfyUI();
  return { ollama, comfy, brain: _brain };
});
ipcMain.on('save-settings', (event, settings) => {
  const mem = loadMemory();
  for (const [k, v] of Object.entries(settings)) { if (v !== undefined && v !== '') mem[k] = v; }
  saveMemoryFile(mem);
  broadcast('memory-update', mem);
});
ipcMain.on('save-memory-key', (event, { key, value }) => {
  const mem = loadMemory(); mem[key] = value; saveMemoryFile(mem);
  broadcast('memory-update', mem);
});
ipcMain.on('delete-memory-key', (event, key) => {
  const mem = loadMemory(); delete mem[key]; saveMemoryFile(mem);
  broadcast('memory-update', mem);
});
ipcMain.on('clear-memory', () => { saveMemoryFile({}); broadcast('memory-update', {}); });
ipcMain.on('get-memory', (event) => { event.returnValue = loadMemory(); });
ipcMain.on('get-learning', (event) => { event.returnValue = loadLearning(); });
ipcMain.on('get-chat-history', (event) => { event.returnValue = _chatHistory; });
ipcMain.on('get-activity-history', (event) => { event.returnValue = _activityHistory; });
ipcMain.handle('get-perf', async () => {
  const perf = await sampleSystemMetrics();
  computeThrottle(perf);
  return {
    gpu: perf.gpuUtil, vram: perf.gpuVramUsedMB, vramTotal: perf.gpuVramTotalMB,
    ram: perf.ramFreeGB, ramTotal: perf.ramTotalGB, cpu: perf.cpuUtil,
    throttle: _perfState.throttleLevel
  };
});
ipcMain.handle('pick-image', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
  });
  return (result.canceled || result.filePaths.length === 0) ? null : result.filePaths[0];
});

// Save pasted clipboard image data to temp file
ipcMain.handle('save-pasted-image', async (event, { dataUrl }) => {
  try {
    const matches = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.+)$/);
    if (!matches) return null;
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buf = Buffer.from(matches[2], 'base64');
    const filePath = path.join(app.getPath('temp'), `geniva_paste_${Date.now()}.${ext}`);
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch (e) { return null; }
});

// Save a dropped file — if it's already on disk return its path, otherwise save buffer
ipcMain.handle('save-dropped-file', async (event, { name, dataUrl }) => {
  try {
    const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return null;
    const buf = Buffer.from(matches[2], 'base64');
    const filePath = path.join(app.getPath('temp'), `geniva_drop_${Date.now()}_${name}`);
    fs.writeFileSync(filePath, buf);
    return filePath;
  } catch (e) { return null; }
});

// Panel open/close
ipcMain.on('open-panel', () => {
  if (!panelWin || panelWin.isDestroyed()) createPanelWindow();
  // Position near fairy but keep on screen
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  if (fairyWin && !fairyWin.isDestroyed()) {
    const fb = fairyWin.getBounds();
    let px = fb.x - 580;
    let py = fb.y - 650;
    if (px < 0) px = fb.x + 130;
    if (py < 0) py = 20;
    if (px + 700 > sw) px = sw - 710;
    if (py + 800 > sh) py = sh - 810;
    panelWin.setPosition(Math.max(0, px), Math.max(0, py));
  }
  panelWin.show();
  panelWin.focus();
});
ipcMain.on('close-panel', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.hide(); });
ipcMain.on('minimize-panel', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.hide(); });

// No-op — window is always full size now
ipcMain.on('fairy-expand', () => {});

// Drag fairy window
ipcMain.on('fairy-drag', (event, { dx, dy }) => {
  if (!fairyWin || fairyWin.isDestroyed()) return;
  const b = fairyWin.getBounds();
  fairyWin.setPosition(b.x + dx, b.y + dy);
  // Broadcast position to brain in real time during drag
  if (brainWin && !brainWin.isDestroyed()) {
    brainWin.webContents.send('fairy-moved', { x: b.x + dx + b.width / 2, y: b.y + dy + b.height / 2 });
  }
});

// Toggle click-through on transparent areas
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (!fairyWin || fairyWin.isDestroyed()) return;
  fairyWin.setIgnoreMouseEvents(ignore, { forward: true });
});

// Save fairy position
ipcMain.on('save-fairy-pos', (event, pos) => {
  const mem = loadMemory(); mem.last_position = pos; saveMemoryFile(mem);
});

// ─── Brain Vault Scanner ───
// BRAIN_VAULT_PATH is defined near the worklog section above

function scanBrainVault() {
  const files = [];
  if (!fs.existsSync(BRAIN_VAULT_PATH)) return { files };

  function walkDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.obsidian') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(full); }
      else if (entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const rel = path.relative(BRAIN_VAULT_PATH, full).replace(/\\/g, '/');
          const name = path.basename(full, '.md');

          // Determine category from path
          let category = 'Other';
          if (rel.startsWith('Projects/')) category = 'Project';
          else if (rel.startsWith('Architecture/')) category = 'Architecture';
          else if (rel.startsWith('Tools/')) category = 'Tool';
          else if (rel.startsWith('Workflows/')) category = 'Workflow';
          else if (rel.startsWith('Sessions/raw/')) category = 'Raw Session';
          else if (rel.startsWith('Sessions/Claude Chats/')) category = 'Claude Chat';
          else if (rel.startsWith('Sessions/')) category = 'Session';
          else if (rel.startsWith('Ideas/')) category = 'Ideas';
          else if (rel.startsWith('People/')) category = 'People';
          // Hub detection
          if (['Home', 'Session Notes', 'Decisions Log', 'Claude Memories', 'Claude Projects'].includes(name)) category = 'Hub';

          // Extract [[wiki links]]
          const linkRegex = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
          const links = [];
          let m;
          while ((m = linkRegex.exec(content)) !== null) {
            // Handle path-style links like Claude Chats/2026-... → extract just the filename
            let linkName = m[1];
            if (linkName.includes('/')) linkName = linkName.split('/').pop();
            links.push(linkName);
          }

          // Preview — first meaningful lines
          const lines = content.split('\n');
          let preview = '';
          let count = 0;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
            preview += trimmed + '\n';
            if (++count >= 6) break;
          }

          files.push({ name, path: rel, category, links, preview: preview.trim() });
        } catch {}
      }
    }
  }

  walkDir(BRAIN_VAULT_PATH);
  return { files };
}

ipcMain.handle('scan-brain-vault', () => scanBrainVault());

ipcMain.handle('get-fairy-position', () => {
  if (!fairyWin || fairyWin.isDestroyed()) return null;
  const b = fairyWin.getBounds();
  // Return center of the fairy sprite (roughly center of the 380x400 window)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});

ipcMain.handle('read-brain-note', (event, relPath) => {
  try {
    const full = path.join(BRAIN_VAULT_PATH, relPath);
    // Safety: make sure it's within the vault
    if (!full.startsWith(BRAIN_VAULT_PATH)) return { error: 'Invalid path' };
    const content = fs.readFileSync(full, 'utf8');
    return { content };
  } catch (e) {
    return { error: e.message };
  }
});

// ─── Brain Window ───
function createBrainWindow() {
  if (brainWin && !brainWin.isDestroyed()) {
    brainWin.close();
    brainWin = null;
    return; // Toggle off
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  brainWin = new BrowserWindow({
    width: sw, height: sh, x: 0, y: 0,
    frame: false, transparent: true, alwaysOnTop: false,
    resizable: false, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    thickFrame: false, roundedCorners: false,
    type: 'desktop',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  brainWin.loadFile('brain.html');
  brainWin.showInactive();
  brainWin.setIgnoreMouseEvents(true, { forward: true });
  brainWin.on('closed', () => { brainWin = null; });
}

// Brain window click-through toggle
ipcMain.on('brain-set-ignore-mouse', (event, ignore) => {
  if (!brainWin || brainWin.isDestroyed()) return;
  brainWin.setIgnoreMouseEvents(ignore, { forward: true });
});

// Context menu
ipcMain.on('show-context-menu', (event) => {
  const template = [
    { label: 'Local Brain', type: 'radio', checked: _brain === 'local', click: () => { _brain = 'local'; broadcast('brain-changed', 'local'); }},
    { label: 'Claude Code Brain', type: 'radio', checked: _brain === 'claude-code', click: () => { _brain = 'claude-code'; broadcast('brain-changed', 'claude-code'); }},
    { label: 'Claude API Brain', type: 'radio', checked: _brain === 'claude-api', click: () => { _brain = 'claude-api'; broadcast('brain-changed', 'claude-api'); }},
    { type: 'separator' },
    { label: brainWin && !brainWin.isDestroyed() ? 'Close Brain' : 'Open Brain', click: () => createBrainWindow() },
    { label: 'Open Full App', click: () => { ipcMain.emit('open-panel'); }},
    { type: 'separator' },
    { label: 'Quit Geniva', click: () => app.quit() }
  ];
  Menu.buildFromTemplate(template).popup(BrowserWindow.fromWebContents(event.sender));
});

// ─── Windows ───
function createFairyWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const mem = loadMemory();
  const pos = mem.last_position || { x: sw - 390, y: sh - 410 };

  fairyWin = new BrowserWindow({
    width: 380, height: 400,
    x: Math.min(pos.x, sw - 380), y: Math.min(pos.y, sh - 400),
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false,
    backgroundColor: '#00000000',
    thickFrame: false, roundedCorners: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  fairyWin.loadFile('index.html');
  // Click-through on transparent areas, but forward mouse events so we detect hover
  fairyWin.setIgnoreMouseEvents(true, { forward: true });

  // Track position on move — broadcast to brain window in real time
  fairyWin.on('moved', () => {
    if (fairyWin && !fairyWin.isDestroyed()) {
      const b = fairyWin.getBounds();
      const mem2 = loadMemory(); mem2.last_position = { x: b.x, y: b.y }; saveMemoryFile(mem2);
      // Notify brain window of new fairy position immediately
      if (brainWin && !brainWin.isDestroyed()) {
        brainWin.webContents.send('fairy-moved', { x: b.x + b.width / 2, y: b.y + b.height / 2 });
      }
    }
  });
}

let _appQuitting = false;

function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: 700, height: 800,
    frame: false, transparent: false, alwaysOnTop: true,
    resizable: true, show: false, backgroundColor: '#1a1a1a',
    minWidth: 500, minHeight: 500,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  panelWin.loadFile('panel.html');
  panelWin.on('close', (e) => {
    if (!_appQuitting) { e.preventDefault(); panelWin.hide(); }
  });
}

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

// Single instance lock — only one Geniva can run at a time
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another Geniva is already running — focus that one and quit this one
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second Geniva — show existing fairy
    if (fairyWin && !fairyWin.isDestroyed()) fairyWin.show();
    if (panelWin && !panelWin.isDestroyed()) panelWin.show();
  });

  app.whenReady().then(() => {
    createFairyWindow();
    createPanelWindow();
    startDebugServer();

    // Lower Ollama process priority (non-blocking)
    try {
      const p = cpSpawn('wmic', ['process', 'where', "name='ollama_llama_server.exe'", 'call', 'setpriority', 'below normal'], { shell: true, stdio: 'ignore' });
      p.on('close', () => console.log('[Geniva] Set Ollama to below-normal priority'));
      p.on('error', () => {});
    } catch {}
  });
}
app.on('before-quit', () => { _appQuitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
