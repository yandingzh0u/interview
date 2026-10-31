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
    note: typeof o.note === 'string' ? o.note : '',
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

// ---------- 防丢失三件套：事件流水 + 覆盖前快照 + 空列表熔断 ----------

const HISTORY = path.join(DATA_DIR, 'history.jsonl');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 80;

// 每一次增删改都追加一行完整记录。哪怕 bank.jsonl 被整表覆盖，也能从这里回放。
async function appendHistory(action, item) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(HISTORY, JSON.stringify({ at: nowISO(), action, item }) + '\n', 'utf8');
  } catch (err) {
    console.error('[history] 写入失败：', err.message);
  }
}

// 每次覆盖题库前，先把当前文件另存一份
async function backupCurrent() {
  try {
    const text = await fs.readFile(BANK, 'utf8');
    if (!text.trim()) return;
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = nowISO().replace(/[^0-9]/g, '').slice(0, 14);
    const file = path.join(BACKUP_DIR, `bank-${stamp}.jsonl`);
    await fs.writeFile(file, text, 'utf8');
    const list = (await fs.readdir(BACKUP_DIR)).filter((f) => f.startsWith('bank-')).sort();
    const drop = list.length - MAX_BACKUPS;
    for (let i = 0; i < drop; i++) await fs.rm(path.join(BACKUP_DIR, list[i]), { force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[backup] 失败：', err.message);
  }
}

// 串行 + 原子写入：先写 .tmp 再 rename，避免半截文件
let writeChain = Promise.resolve();
function persist(opts = {}) {
  const snapshot = items.slice(); // 拷贝快照，不持有引用
  const allowEmpty = opts.allowEmpty === true;
  const run = async () => {
    // 熔断：绝不用一个空列表去覆盖还有内容的题库
    if (!snapshot.length && !allowEmpty) {
      let old = '';
      try {
        old = await fs.readFile(BANK, 'utf8');
      } catch {}
      if (old.trim()) {
        console.error('[熔断] 试图用空列表覆盖非空题库，已拒绝');
        throw new Error('已拒绝：写入内容为空，但磁盘上还有题目。请检查后重试。');
      }
    }
    const text = snapshot.map((x) => JSON.stringify(x)).join('\n') + (snapshot.length ? '\n' : '');
    const tmp = BANK + '.tmp';
    await backupCurrent();
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
      // 关键：改之前先对齐磁盘。否则内存里的旧快照会把外部的改动整表覆盖掉。
      await reloadIfChanged();
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
          note: body.note ?? prev.note,
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
          note: body.note,
          src: body.src,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });
        items.push(item);
      }
      await persist();
      await appendHistory(body.id ? 'update' : 'create', item);
      return json(res, 200, { item });
    }

    if (p === '/api/questions/delete' && req.method === 'POST') {
      await reloadIfChanged();
      const body = JSON.parse(await readBody(req));
      const it = items.find((x) => x.id === body.id);
      if (!it) return json(res, 404, { error: '题目不存在' });
      it.deleted = true;
      it.updatedAt = nowISO();
      await persist();
      await appendHistory('delete', it);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/questions/restore' && req.method === 'POST') {
      await reloadIfChanged();
      const body = JSON.parse(await readBody(req));
      const it = items.find((x) => x.id === body.id);
      if (!it) return json(res, 404, { error: '题目不存在' });
      it.deleted = false;
      it.updatedAt = nowISO();
      await persist();
      await appendHistory('restore', it);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/questions/purge' && req.method === 'POST') {
      await reloadIfChanged();
      const body = JSON.parse(await readBody(req));
      const before = items.length;
      items = items.filter((x) => x.id !== body.id);
      if (items.length === before) return json(res, 404, { error: '题目不存在' });
      await persist({ allowEmpty: true });
      await appendHistory('purge', { id: body.id });
      return json(res, 200, { ok: true });
    }

    // ---------- 找回：列出 / 恢复历史快照 ----------
    if (p === '/api/backups' && req.method === 'GET') {
      let list = [];
      try {
        list = (await fs.readdir(BACKUP_DIR))
          .filter((f) => f.startsWith('bank-') && f.endsWith('.jsonl'))
          .sort()
          .reverse();
      } catch {}
      const out = [];
      for (const f of list.slice(0, 40)) {
        try {
          const text = await fs.readFile(path.join(BACKUP_DIR, f), 'utf8');
          const rows = text.split(/\r?\n/).filter(Boolean);
          out.push({ file: f, count: rows.length, bytes: Buffer.byteLength(text) });
        } catch {}
      }
      return json(res, 200, { backups: out });
    }

    if (p === '/api/backups/restore' && req.method === 'POST') {
      await reloadIfChanged();
      const body = JSON.parse(await readBody(req));
      const name = String(body.file || '');
      // 只允许读 backups 目录里的 bank-*.jsonl，杜绝路径穿越
      if (!/^bank-\d{14}\.jsonl$/.test(name)) return json(res, 400, { error: '文件名不合法' });
      let text;
      try {
        text = await fs.readFile(path.join(BACKUP_DIR, name), 'utf8');
      } catch {
        return json(res, 404, { error: '快照不存在' });
      }
      const byId = new Map(items.map((x) => [x.id, x]));
      let added = 0;
      let filled = 0;
      text.split(/\r?\n/).forEach((line) => {
        const s = line.trim();
        if (!s) return;
        let o;
        try {
          o = JSON.parse(s);
        } catch {
          return;
        }
        if (!o || !o.q) return;
        const rec = normalize(o);
        const prev = byId.get(rec.id);
        if (!prev) {
          byId.set(rec.id, rec);
          added++;
          return;
        }
        // 现有的段落是空的、快照里有内容 → 用快照补回
        if (!prev.segments.filter((x) => String(x).trim()).length && rec.segments.filter((x) => String(x).trim()).length) {
          prev.segments = rec.segments;
          filled++;
        }
      });
      items = Array.from(byId.values());
      await persist({ allowEmpty: true });
      await appendHistory('restore-backup', { file: name, added, filled });
      return json(res, 200, { ok: true, added, filled, total: items.length });
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
  const port = PORT_START;
  try {
    server = await listenOn(port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      // 已经有实例在跑。绝不能退到 7789 再起一个 ——
      // 两个实例各自在内存里握着一整份题库，谁后保存谁覆盖整个文件，题目就是这么丢的。
      const url = `http://127.0.0.1:${port}/`;
      console.log('');
      console.log('  已经有一个背题服务在运行：' + url);
      console.log('  直接用它就行，不再启动第二个（两个实例会互相覆盖题库）。');
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
      return;
    }
    throw err;
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
