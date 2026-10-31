// 本地背题服务 —— 零依赖，只用 Node 内置模块
// 数据真相源：data/bank.jsonl（一行一题）

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const BANK = path.join(DATA_DIR, 'bank.jsonl');
const WEB_DIR = path.join(ROOT, 'web');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const PORT_START = 7788;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.jsonl': 'text/plain; charset=utf-8',
};

// ---------- 内存中的题库 ----------
let items = [];
let loadErrors = [];

function nowISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`
  );
}

function newId() {
  const used = new Set(items.map((x) => x.id));
  for (let i = 0; i < 200; i++) {
    const id = 'q_' + Math.random().toString(36).slice(2, 8);
    if (!used.has(id)) return id;
  }
  return 'q_' + Date.now().toString(36);
}

function normalize(o) {
  const fu = Array.isArray(o.fu)
    ? o.fu
        .map((x) =>
          typeof x === 'string'
            ? { q: String(x).trim(), hint: '' }
            : { q: String((x && x.q) || '').trim(), hint: String((x && x.hint) || '').trim() }
        )
        .filter((x) => x.q)
        .slice(0, 30)
    : [];

  const segments = Array.isArray(o.segments)
    ? o.segments.map((x) => String(x ?? ''))
    : typeof o.a === 'string' && o.a.trim()
      ? [o.a]
      : [];

  return {
    id: typeof o.id === 'string' && o.id ? o.id : newId(),
    q: typeof o.q === 'string' ? o.q : String(o.q ?? ''),
    cat: typeof o.cat === 'string' && o.cat.trim() ? o.cat.trim() : '解释原理',
    sub: typeof o.sub === 'string' ? o.sub.trim() : '',
    segments,
    fu,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : nowISO(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : nowISO(),
    deleted: o.deleted === true,
  };
}

async function loadBank() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let text = '';
  try {
    text = await fs.readFile(BANK, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.writeFile(BANK, '', 'utf8');
      items = [];
      loadErrors = [];
      return;
    }
    throw err;
  }
  const parsed = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try {
      const o = JSON.parse(s);
      if (!o || typeof o !== 'object') throw new Error('不是 JSON 对象');
      if (!o.q || !String(o.q).trim()) throw new Error('缺少 q 字段');
      parsed.push(normalize(o));
    } catch (err) {
      errors.push({ line: i + 1, msg: err.message });
    }
  });
  items = parsed;
  loadErrors = errors;
}

// 串行 + 原子写入：先写 .tmp 再 rename，避免半截文件
let writeChain = Promise.resolve();
function persist() {
  const snapshot = items;
  const run = async () => {
    const text = snapshot.map((x) => JSON.stringify(x)).join('\n') + (snapshot.length ? '\n' : '');
    const tmp = BANK + '.tmp';
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, BANK);
    try {
      const st = await fs.stat(BANK);
      lastMtimeMs = st.mtimeMs;
    } catch {}
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

// 你在外部用记事本改了文件时，下次请求自动重新载入
let lastMtimeMs = 0;
async function reloadIfChanged() {
  let st;
  try {
    st = await fs.stat(BANK);
  } catch {
    return;
  }
  if (st.mtimeMs === lastMtimeMs) return;
  await loadBank();
  lastMtimeMs = st.mtimeMs;
}

// ---------- HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  let baseDir = WEB_DIR;
  let rel = urlPath;
  if (urlPath.startsWith('/vendor/')) {
    baseDir = VENDOR_DIR;
    rel = urlPath.slice('/vendor/'.length);
  } else {
    rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
    return;
  }
  const normBase = path.resolve(baseDir);
  const full = path.resolve(normBase, decoded);
  const inside = path.relative(normBase, full);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (p === '/api/frameworks' && req.method === 'GET') {
      try {
        const text = await fs.readFile(path.join(DATA_DIR, 'frameworks.json'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(text);
      } catch (err) {
        return json(res, 500, { error: '读取 frameworks.json 失败：' + err.message });
      }
    }

    if (p === '/api/questions' && req.method === 'GET') {
      await reloadIfChanged();
      return json(res, 200, { items, errors: loadErrors });
    }

    if (p === '/api/questions' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: '请求体不是合法 JSON' });
      }
      const q = String(body.q ?? '').trim();
      if (!q) return json(res, 400, { error: '题目不能为空' });

      let item;
      if (body.id) {
        const idx = items.findIndex((x) => x.id === body.id);
        if (idx === -1) return json(res, 404, { error: '题目不存在' });
        const prev = items[idx];
        item = normalize({
          ...prev,
          q,
          cat: body.cat ?? prev.cat,
          sub: body.sub ?? prev.sub,
          segments: body.segments ?? prev.segments,
          fu: body.fu ?? prev.fu,
          deleted: body.deleted ?? prev.deleted,
          createdAt: prev.createdAt,
          updatedAt: nowISO(),
        });
        item.id = prev.id;
        items[idx] = item;
      } else {
        item = normalize({
          q,
          cat: body.cat,
          sub: body.sub,
          segments: body.segments,
          fu: body.fu,
          src: body.src,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
        items.push(item);
      }
      await persist();
      return json(res, 200, { item });
    }

    if (p === '/api/questions/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const it = items.find((x) => x.id === body.id);
      if (!it) return json(res, 404, { error: '题目不存在' });
      it.deleted = true;
      it.updatedAt = nowISO();
      await persist();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/questions/restore' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const it = items.find((x) => x.id === body.id);
      if (!it) return json(res, 404, { error: '题目不存在' });
      it.deleted = false;
      it.updatedAt = nowISO();
      await persist();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/questions/purge' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const before = items.length;
      items = items.filter((x) => x.id !== body.id);
      if (items.length === before) return json(res, 404, { error: '题目不存在' });
      await persist();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/export' && req.method === 'GET') {
      await reloadIfChanged();
      const text = items.filter((x) => !x.deleted).map((x) => JSON.stringify(x)).join('\n') + '\n';
      const stamp = nowISO().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/jsonl; charset=utf-8',
        'Content-Disposition': `attachment; filename="bank-${stamp}.jsonl"`,
      });
      return res.end(text);
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: '未知接口' });

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p);

    return json(res, 405, { error: '不支持的请求方法' });
  } catch (err) {
    console.error('[500]', err);
    return json(res, 500, { error: err.message || '服务端错误' });
  }
};

async function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function main() {
  await loadBank();
  try {
    const st = await fs.stat(BANK);
    lastMtimeMs = st.mtimeMs;
  } catch {}
  let server = null;
  let port = 0;
  for (let n = 0; n < 20; n++) {
    const candidate = PORT_START + n;
    try {
      server = await listenOn(candidate);
      port = candidate;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!server) {
    console.error('端口 7788-7807 都被占用了，无法启动。');
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log('');
  console.log('  背题 · 本地服务已启动');
  console.log('  ' + url);
  console.log(`  题库：${BANK}`);
  console.log(`  共 ${items.length} 道题${loadErrors.length ? `（${loadErrors.length} 行格式错误已跳过）` : ''}`);
  console.log('');
  console.log('  关闭这个窗口 = 停止服务（题库已存盘，不会丢）');
  console.log('');

  if (!process.argv.includes('--no-open')) {
    const cmd =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
