import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function isWithin(root, file) {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function createAppServer({ publicDir = resolve(directory, 'public') } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Method not allowed');
    }
    let path;
    try {
      path = decodeURIComponent(request.url.split('?')[0]);
    } catch {
      return send(400, 'Invalid request path');
    }
    if (!path.startsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').some(part => part.startsWith('.'))) {
      return send(403, 'Forbidden');
    }
    if (path === '/health') {
      return send(200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
    }
    try {
      const root = await realpath(publicDir);
      const requested = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!isWithin(root, requested)) return send(403, 'Forbidden');
      const file = await realpath(requested);
      if (!isWithin(root, file)) return send(403, 'Forbidden');
      if (!(await stat(file)).isFile()) return send(404, 'Not found');
      const type = types[extname(file)];
      if (!type) return send(404, 'Not found');
      send(200, await readFile(file), type);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return send(404, 'Not found');
      send(500, 'Server error');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exit(1);
  }
  const server = createAppServer();
  server.on('error', error => {
    console.error(`Server failed to start (${error.code ?? 'unknown error'}).`);
    process.exitCode = 1;
  });
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Trading education server listening on port ${port}.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close());
  }
}
