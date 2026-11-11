// Minimal production server: serves the built app from ./dist and the
// Yahoo Finance proxy under /api/yf/*. Run `npm run build && npm start`.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { yahooHandler } from './yahoo.js';

const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(root, 'index.html'); // SPA fallback
  }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    if (file.includes(`${sep}assets${sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found — did you run `npm run build`?');
  }
}

createServer((req, res) => {
  if (req.url.startsWith('/api/')) return yahooHandler(req, res);
  return serveStatic(req, res);
}).listen(port, host, () => {
  console.log(`Finance Agent Team running at http://localhost:${port}`);
});
