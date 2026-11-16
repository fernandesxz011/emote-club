export const CATEGORIES = ['Feliz', 'Muito feliz', 'Triste', 'Muito triste', 'Confirmação', 'Negação', 'Raiva', 'Surpresa', 'Dança', 'Cumprimentos', 'Descanso', 'Medo', 'Confiança'];

const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: responseHeaders});
const fail = (message, status = 400) => json({error: message}, status);

export function parseAssetId(value) {
  const input = String(value ?? '').trim();
  if (/^\d{6,16}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !['roblox.com', 'www.roblox.com'].includes(url.hostname)) return null;
    return url.pathname.match(/^\/(?:catalog|library)\/(\d{6,16})(?:\/|$)/)?.[1] ?? null;
  } catch { return null; }
}

function identity(request) {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id) return null;
  let name = request.headers.get('oai-authenticated-user-full-name');
  if (name && request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { name = decodeURIComponent(name); } catch { name = null; }
  }
  return {id, name: name || request.headers.get('oai-authenticated-user-email') || 'Pessoa da equipe'};
}

async function bodyOf(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('Envie os dados em formato JSON.');
  const raw = await request.text();
  if (raw.length > 12000) throw new Error('O cadastro está muito grande. Reduza a descrição e as palavras-chave.');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new Error('Não foi possível ler o cadastro. Confira os campos e tente novamente.'); }
}

export async function verifyRoblox(id, fetcher = fetch) {
  let details;
  try {
    const response = await fetcher(`https://catalog.roblox.com/v1/catalog/items/${id}/details?itemType=Asset`, {signal: AbortSignal.timeout(10000)});
    if (response.status === 404) return {error: 'Este ID não foi encontrado no catálogo do Roblox.', status: 400};
    if (!response.ok) return {error: 'O catálogo do Roblox está indisponível. Tente verificar novamente em instantes.', status: 503};
    details = await response.json();
  } catch { return {error: 'Não foi possível consultar o Roblox agora. Tente novamente em instantes.', status: 503}; }
  if (Number(details.assetType) !== 61) return {error: 'Este ID não é um emote do catálogo do Roblox. Use o ID da página do emote, não o ID de uma animação.', status: 400};
  if (!details.name) return {error: 'O Roblox não retornou os dados deste emote. Tente novamente.', status: 503};
  let thumbnail = null;
  try {
    const response = await fetcher(`https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png&isCircular=false`, {signal: AbortSignal.timeout(5000)});
    if (response.ok) {
      const data = await response.json();
      const candidate = data.data?.find(item => String(item.targetId) === id && item.state === 'Completed')?.imageUrl;
      if (candidate && /^https:\/\/[^/]+\.rbxcdn\.com\//.test(candidate)) thumbnail = candidate;
    }
  } catch { /* Thumbnail availability does not determine whether an emote exists. */ }
  return {item: {id, name: String(details.name).slice(0, 150), creator: String(details.creatorName || 'Criador no Roblox').slice(0, 150), thumbnail, source: `https://www.roblox.com/catalog/${id}`, verified: true}};
}

export function createWorker({seed = [], assets = {}, fetcher = fetch} = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const path = url.pathname;
      const user = identity(request);

      if (path === '/api/health' && request.method === 'GET') return json({ok: true, database: Boolean(env.DB)});
      if (path === '/api/me' && request.method === 'GET') return json({signedIn: Boolean(user), name: user?.name ?? null});

      if (path === '/api/emotes' && request.method === 'GET') {
        if (!env.DB) return json({items: seed, storage: 'unavailable', warning: 'O catálogo está disponível para consulta. O cadastro compartilhado está temporariamente indisponível.'});
        try {
          const result = await env.DB.prepare('SELECT item_json FROM emotes ORDER BY created_at DESC LIMIT 2000').all();
          const additions = (result.results || []).map(row => JSON.parse(row.item_json));
          return json({items: [...seed, ...additions.filter(item => !seed.some(existing => String(existing.id) === String(item.id)))], storage: 'shared'});
        } catch {
          return json({items: seed, storage: 'unavailable', warning: 'Não foi possível carregar os cadastros da equipe agora. Tente novamente em instantes.'});
        }
      }

      if ((path === '/api/emotes' || path === '/api/validate') && request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return fail('Esta solicitação veio de outro site. Abra o Emote Club e tente novamente.', 403);
        if (!user) return fail('Entre com sua conta do ChatGPT para adicionar emotes à biblioteca da equipe.', 401);
        let body;
        try { body = await bodyOf(request); } catch (error) { return fail(error.message); }
        const id = parseAssetId(body.id);
        if (!id) return fail('Informe um ID de catálogo válido ou um link https://www.roblox.com/catalog/ID.');
        if (path === '/api/validate') {
          const result = await verifyRoblox(id, fetcher);
          return result.error ? fail(result.error, result.status) : json(result);
        }
        if (!env.DB) return fail('O cadastro compartilhado está temporariamente indisponível. Tente novamente em instantes.', 503);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (name.length < 2 || name.length > 150) return fail('O nome precisa ter entre 2 e 150 caracteres.');
        if (!CATEGORIES.includes(body.category)) return fail('Selecione uma das emoções da lista.');
        if (description.length < 10 || description.length > 600) return fail('Descreva o emote usando entre 10 e 600 caracteres.');
        if (!Array.isArray(body.tags) || body.tags.length > 10 || body.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 30)) return fail('Use até 10 palavras-chave com no máximo 30 caracteres cada.');
        if (seed.some(item => String(item.id) === id)) return fail('Este emote já está na biblioteca. Busque pelo ID para encontrá-lo.', 409);
        try {
          const existing = await env.DB.prepare('SELECT id FROM emotes WHERE id = ?').bind(id).first();
          if (existing) return fail('Este emote já foi adicionado pela equipe. Busque pelo ID para encontrá-lo.', 409);
        } catch { return fail('Não foi possível acessar o catálogo compartilhado. Tente novamente em instantes.', 503); }
        const checked = await verifyRoblox(id, fetcher);
        if (checked.error) return fail(checked.error, checked.status);
        const createdAt = new Date().toISOString();
        const item = {...checked.item, category: body.category, description, tags: [...new Set(body.tags.map(tag => tag.trim().toLowerCase()))], addedBy: user.name, createdAt, verifiedAt: createdAt.slice(0, 10), testedInGame: false};
        try {
          await env.DB.prepare('INSERT INTO emotes (id, item_json, created_at) VALUES (?, ?, ?)').bind(id, JSON.stringify(item), item.createdAt).run();
          return json({item}, 201);
        } catch (error) {
          if (/unique|constraint/i.test(String(error?.message))) return fail('Este emote acabou de ser adicionado pela equipe. Atualize a biblioteca.', 409);
          return fail('Não foi possível salvar o emote. Os dados continuam no formulário para você tentar novamente.', 503);
        }
      }

      if (path.startsWith('/api/')) return fail('Esta ação não foi encontrada.', 404);
      if (!['GET', 'HEAD'].includes(request.method)) return fail('Método não permitido.', 405);
      const key = path === '/' || path === '/index.html' ? '/index.html' : path;
      const asset = assets[key];
      if (!asset) return new Response('Página não encontrada', {status: 404});
      const bytes = Uint8Array.from(atob(asset.body), char => char.charCodeAt(0));
      return new Response(request.method === 'HEAD' ? null : bytes, {headers: {
        'Content-Type': asset.type,
        'Cache-Control': key.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      }});
    }
  };
}
