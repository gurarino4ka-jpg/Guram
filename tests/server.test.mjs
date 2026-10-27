import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createAppServer } from '../server.mjs';

test('server serves the application and protects files outside public', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tradelab-server-'));
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<h1>ТрейдЛаб</h1>');
  await writeFile(join(publicDir, 'app.mjs'), 'export const ready = true;');
  await writeFile(join(root, 'private.json'), '{"private":true}');
  await symlink(join(root, 'private.json'), join(publicDir, 'linked.json'));
  const server = createAppServer({ publicDir });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /ТрейдЛаб/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match((await get('/app.mjs')).headers['content-type'], /javascript/);
  assert.deepEqual(JSON.parse((await get('/health')).body), { status: 'ok' });
  assert.equal((await get('/', 'HEAD')).body, '');
  assert.equal((await get('/', 'POST')).status, 405);
  assert.equal((await get('/missing')).status, 404);
  assert.equal((await get('/%ZZ')).status, 400);
  for (const path of ['/../private.json', '/%2e%2e/private.json', '/.git/config', '/linked.json', '/a%5c..%5cprivate.json']) {
    assert.equal((await get(path)).status, 403, path);
  }
});
