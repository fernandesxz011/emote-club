import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {buildPages, PUBLIC_FILES} from '../scripts/build-pages.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('Pages publica só arquivos estáticos públicos e uma configuração sem credenciais', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'emoteclub-pages-'));
  try {
    for (const file of PUBLIC_FILES) await writeFile(path.join(root, file), file);
    await writeFile(path.join(root, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://old-api.example.com; font-src 'self' https://fonts.gstatic.com">`);
    await mkdir(path.join(root, 'assets'));
    await mkdir(path.join(root, '.openai'));
    await writeFile(path.join(root, 'assets', 'emote-123.png'), 'public image');
    await writeFile(path.join(root, 'assets', '.private.env'), 'private');
    await writeFile(path.join(root, 'assets', 'database.sqlite'), 'private');
    await writeFile(path.join(root, '.openai', 'hosting.json'), '{"project_id":"private-project"}');
    await writeFile(path.join(root, '.env'), 'SECRET=private');
    await writeFile(path.join(root, 'server.js'), 'private server');
    const {output} = await buildPages({root, apiBaseUrl: 'https://api.example.com/'});
    assert.deepEqual((await readdir(output)).sort(), [...PUBLIC_FILES, 'assets', 'config.js', '.nojekyll'].sort());
    assert.deepEqual(await readdir(path.join(output, 'assets')), ['emote-123.png']);
    const context = {window: {}};
    runInNewContext(await readFile(path.join(output, 'config.js'), 'utf8'), context);
    assert.equal(context.window.EMOTECLUB_CONFIG.apiBaseUrl, 'https://api.example.com');
    assert.deepEqual(Object.keys(context.window.EMOTECLUB_CONFIG), ['apiBaseUrl']);
    assert.ok(Object.isFrozen(context.window.EMOTECLUB_CONFIG));
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    assert.match(html, /connect-src 'self' https:\/\/api\.example\.com/);
    assert.match(html, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
    assert.doesNotMatch(html, /old-api\.example\.com/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('Pages rejeita configuração com credenciais, parâmetros, caminhos ou HTTP', async () => {
  for (const apiBaseUrl of ['https://user:password@api.example.com', 'https://api.example.com/?token=secret', 'https://api.example.com/#secret', 'https://api.example.com/api', 'http://api.example.com', 'invalid']) {
    await assert.rejects(buildPages({apiBaseUrl}), /EMOTECLUB_API_BASE_URL/);
  }
});

test('Referências públicas resolvem sob /emote-club/ sem sair da base do Pages', async () => {
  const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
  const app = await readFile(path.join(projectRoot, 'app.js'), 'utf8');
  const base = new URL('https://example.github.io/emote-club/');
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  const local = references.filter(value => !value.startsWith('#') && !/^[a-z][a-z\d+.-]*:/i.test(value));
  assert.ok(local.some(value => value.includes('config.js')), 'config.js deve ser carregado antes do app');
  assert.ok(html.indexOf('config.js') < html.indexOf('app.js'), 'a configuração precisa vir antes do app');
  for (const reference of local) assert.ok(new URL(reference, base).pathname.startsWith(base.pathname), `Referência fora da base: ${reference}`);
  assert.ok(/from\s+['"]\.\/library\.js['"]/.test(app), 'library.js deve usar import relativo');
  assert.ok(!/fetch\(['"]\/(?:seed\.json|catalog-audit\.json)/.test(app), 'JSON estático deve usar caminho relativo');
  assert.ok(!/['"]\/assets\//.test(app), 'URLs de imagem devem preservar a base do Pages');
});
