import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4173;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
]);

function send(res, status, message, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(message);
}

function resolveRequestPath(pathname) {
  const relative = pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative || 'index.html');
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return null;
  return filePath;
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
  } catch {
    send(response, 400, 'Bad Request');
    return;
  }

  let filePath = resolveRequestPath(pathname);
  if (!filePath) {
    send(response, 403, 'Forbidden');
    return;
  }

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      info = await stat(filePath);
    }
    if (!info.isFile()) {
      send(response, 404, 'Not Found');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    };

    if (request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return;
    }

    response.writeHead(200, headers);
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      send(response, 404, 'Not Found');
      return;
    }
    console.error(error);
    send(response, 500, 'Internal Server Error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`世系 · 族谱图  http://${HOST}:${PORT}`);
  console.log('按 Ctrl+C 停止服务器。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
