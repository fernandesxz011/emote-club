import {readFile, readdir, mkdir, writeFile, rm, cp} from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const mime = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
const assets = {};
async function assetFile(relative) {
  const data = await readFile(path.join(root, relative));
  assets['/' + relative.replaceAll(path.sep, '/')] = {body: data.toString('base64'), type: mime[path.extname(relative)] || 'application/octet-stream'};
}
async function assetDirectory(relative) {
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await assetDirectory(child); else await assetFile(child);
  }
}
for (const file of ['index.html', 'styles.css', 'app.js', 'library.js', 'seed.json', 'catalog-audit.json']) await assetFile(file);
try { await assetDirectory('assets'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const seed = JSON.parse(await readFile(path.join(root, 'seed.json'), 'utf8'));
if (!Array.isArray(seed) || !seed.length) throw new Error('seed.json precisa conter os emotes pesquisados.');
const manifest = JSON.parse(await readFile(path.join(root, '.openai/hosting.json'), 'utf8'));
if (!manifest.project_id) throw new Error('O projeto Sites precisa estar registrado antes do build.');
if (manifest.static) throw new Error('O catálogo compartilhado usa Worker; remova o campo static.');
await rm(path.join(root, 'dist'), {recursive: true, force: true});
await mkdir(path.join(root, 'dist/server'), {recursive: true});
await mkdir(path.join(root, 'dist/.openai'), {recursive: true});
const server = await readFile(path.join(root, 'server.js'), 'utf8');
await writeFile(path.join(root, 'dist/server/index.js'), server + '\nexport default createWorker({seed:' + JSON.stringify(seed) + ',assets:' + JSON.stringify(assets) + '});\n');
await writeFile(path.join(root, 'dist/.openai/hosting.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(path.join(root, 'drizzle'), path.join(root, 'dist/drizzle'), {recursive: true});
console.log(`Worker pronto: ${seed.length} emotes e ${Object.keys(assets).length} arquivos incorporados.`);
