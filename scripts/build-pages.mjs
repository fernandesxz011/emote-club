import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_API_BASE_URL = 'https://emote-club-studio.fernandesxz011.chatgpt.site';
export const PUBLIC_FILES = ['index.html', 'styles.css', 'app.js', 'library.js', 'session-store.js', 'seed.json', 'catalog-audit.json'];
const assetExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif', '.woff', '.woff2', '.ttf', '.otf']);

function publicApiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('EMOTECLUB_API_BASE_URL precisa ser uma URL HTTPS válida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('EMOTECLUB_API_BASE_URL deve conter apenas a origem HTTPS pública da API, sem credenciais ou caminhos.');
  }
  return url.origin;
}

function configureConnectPolicy(html, apiOrigin) {
  return html.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>/i, meta => meta.replace(/(\bcontent\s*=\s*")([^"]*)(")/i, (_, before, policy, after) => {
    const directives = policy.split(';').map(value => value.trim()).filter(Boolean);
    const index = directives.findIndex(value => /^connect-src(?:\s|$)/i.test(value));
    const connect = `connect-src 'self' ${apiOrigin}`;
    if (index === -1) directives.push(connect); else directives[index] = connect;
    return before + directives.join('; ') + after;
  }));
}

async function copyAssets(root, output, relative = 'assets') {
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Link simbólico não permitido nos assets públicos: ${child}`);
    if (entry.isDirectory()) await copyAssets(root, output, child);
    else if (entry.isFile() && assetExtensions.has(path.extname(entry.name).toLowerCase())) {
      await mkdir(path.dirname(path.join(output, child)), {recursive: true});
      await cp(path.join(root, child), path.join(output, child));
    }
  }
}

export async function buildPages({root = process.cwd(), apiBaseUrl = process.env.EMOTECLUB_API_BASE_URL || DEFAULT_API_BASE_URL} = {}) {
  const apiOrigin = publicApiOrigin(apiBaseUrl);
  const output = path.join(root, 'pages');
  // Read required files before replacing a previous successful output.
  const files = await Promise.all(PUBLIC_FILES.map(async file => [file, await readFile(path.join(root, file))]));
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  for (const [file, body] of files) await writeFile(path.join(output, file), file === 'index.html' ? configureConnectPolicy(body.toString('utf8'), apiOrigin) : body);
  await copyAssets(root, output);
  await writeFile(path.join(output, 'config.js'), `window.EMOTECLUB_CONFIG = Object.freeze(${JSON.stringify({apiBaseUrl: apiOrigin})});\n`);
  await writeFile(path.join(output, '.nojekyll'), '');
  console.log(`GitHub Pages pronto em pages/; API pública: ${apiOrigin}`);
  return {output, apiBaseUrl: apiOrigin};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPages();
