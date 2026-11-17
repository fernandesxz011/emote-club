import {AuthError, registerAccount, loginAccount, logoutAccount, sessionIdentity} from './auth.js';

export const CATEGORIES = ['Feliz', 'Muito feliz', 'Triste', 'Muito triste', 'Confirmação', 'Negação', 'Raiva', 'Surpresa', 'Dança', 'Cumprimentos', 'Descanso', 'Medo', 'Confiança'];

const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: responseHeaders});
const fail = (message, status = 400, code) => json({error: message, ...(code ? {code} : {})}, status);

async function readProfile(db, userId) {
  const row = await db.prepare('SELECT display_name, created_at FROM profiles WHERE user_id = ?').bind(userId).first();
  return row ? {displayName: row.display_name, createdAt: row.created_at} : null;
}

async function readSaved(db, userId) {
  const result = await db.prepare('SELECT emote_id, saved_at FROM saved_emotes WHERE user_id = ? ORDER BY saved_at DESC').bind(userId).all();
  return (result.results || []).map(row => ({id: row.emote_id, savedAt: row.saved_at}));
}

export function parseAssetId(value) {
  const input = String(value ?? '').trim();
  if (/^\d{6,16}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !['roblox.com', 'www.roblox.com'].includes(url.hostname)) return null;
    return url.pathname.match(/^\/(?:catalog|library)\/(\d{6,16})(?:\/|$)/)?.[1] ?? null;
  } catch { return null; }
}

async function bodyOf(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('Envie os dados em formato JSON.');
  const maxBytes = 12 * 1024;
  const oversized = () => new AuthError('O formulário está muito grande. Reduza os dados e tente novamente.', 413, 'BODY_TOO_LARGE');
  if (Number(request.headers.get('content-length')) > maxBytes) throw oversized();
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw oversized();
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder().decode(bytes);
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
  const catalogSeed = seed.map(item => ({...item, createdAt: item.createdAt || '2026-11-16T23:47:52.897Z'}));
  async function userSnapshot(db, user) {
    const [profile, saved] = await Promise.all([readProfile(db, user.id), readSaved(db, user.id)]);
    return {signedIn: true, name: profile?.displayName || user.name, username: user.username, profile, saved, storage: 'shared'};
  }
  async function handleRequest(request, env = {}) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/health' && request.method === 'GET') return json({ok: true, database: Boolean(env.DB)});
      if ((path === '/api/auth/register' || path === '/api/auth/login') && request.method === 'POST') {
        let body;
        try { body = await bodyOf(request); } catch (error) { return fail(error.message, error.status || 400, error.code); }
        const result = path.endsWith('/register') ? await registerAccount(env.DB, request, body) : await loginAccount(env.DB, request, body);
        return json({token: result.token, expiresAt: result.expiresAt, user: await userSnapshot(env.DB, result.user)}, path.endsWith('/register') ? 201 : 200);
      }
      if (path === '/api/auth/logout' && request.method === 'POST') return json(await logoutAccount(env.DB, request));

      const needsIdentity = path === '/api/me' || path === '/api/profile' || path === '/api/saved' || (request.method === 'POST' && (path === '/api/emotes' || path === '/api/validate'));
      const user = needsIdentity ? await sessionIdentity(request, env.DB) : null;
      if (path === '/api/me' && request.method === 'GET') {
        const base = {signedIn: false, name: null, username: null, profile: null, saved: [], storage: env.DB ? 'shared' : 'unavailable'};
        if (!user) return json(base);
        return json(await userSnapshot(env.DB, user));
      }

      if ((path === '/api/profile' || path === '/api/saved') && request.method === 'POST') {
        if (!user) return fail('Entre na sua conta para usar sua biblioteca pessoal.', 401);
        if (!env.DB) return fail('Sua biblioteca pessoal está temporariamente indisponível. Tente novamente em instantes.', 503);
        let body;
        try { body = await bodyOf(request); } catch (error) { return fail(error.message, error.status || 400, error.code); }

        if (path === '/api/profile') {
          const displayName = typeof body.displayName === 'string' ? body.displayName.trim().replace(/\s+/g, ' ') : '';
          if (displayName.length < 2 || displayName.length > 50 || /[\u0000-\u001f\u007f]/.test(displayName)) return fail('Escolha um nome com 2 a 50 caracteres.');
          const now = new Date().toISOString();
          try {
            await env.DB.prepare('INSERT INTO profiles (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at').bind(user.id, displayName, now, now).run();
            const [profile, saved] = await Promise.all([readProfile(env.DB, user.id), readSaved(env.DB, user.id)]);
            return json({profile, saved, name: profile.displayName, storage: 'shared'});
          } catch {
            return fail('Não foi possível salvar seu perfil agora. Tente novamente em instantes.', 503);
          }
        }

        const id = parseAssetId(body.id);
        if (!id) return fail('Informe um ID de emote válido para salvar na sua biblioteca.');
        if (typeof body.saved !== 'boolean') return fail('Informe se o emote deve ser salvo ou removido da sua biblioteca.');
        try {
          const profile = await readProfile(env.DB, user.id);
          if (!profile) return fail('Crie seu perfil para salvar emotes na sua biblioteca pessoal.', 409, 'PROFILE_REQUIRED');
          if (!catalogSeed.some(item => String(item.id) === id)) {
            const existing = await env.DB.prepare('SELECT id FROM emotes WHERE id = ?').bind(id).first();
            if (!existing) return fail('Este emote não foi encontrado na biblioteca da equipe.', 404);
          }
          if (!body.saved) {
            await env.DB.prepare('DELETE FROM saved_emotes WHERE user_id = ? AND emote_id = ?').bind(user.id, id).run();
            return json({id, saved: false, savedAt: null});
          }
          const now = new Date().toISOString();
          await env.DB.prepare('INSERT INTO saved_emotes (user_id, emote_id, saved_at) VALUES (?, ?, ?) ON CONFLICT(user_id, emote_id) DO NOTHING').bind(user.id, id, now).run();
          const stored = await env.DB.prepare('SELECT saved_at FROM saved_emotes WHERE user_id = ? AND emote_id = ?').bind(user.id, id).first();
          return json({id, saved: true, savedAt: stored.saved_at});
        } catch {
          return fail('Não foi possível atualizar seus emotes salvos. Tente novamente em instantes.', 503);
        }
      }

      if (path === '/api/emotes' && request.method === 'GET') {
        if (!env.DB) return json({items: catalogSeed, storage: 'unavailable', warning: 'O catálogo está disponível para consulta. O cadastro compartilhado está temporariamente indisponível.'});
        try {
          const result = await env.DB.prepare('SELECT item_json FROM emotes ORDER BY created_at DESC LIMIT 2000').all();
          const additions = (result.results || []).map(row => JSON.parse(row.item_json));
          return json({items: [...catalogSeed, ...additions.filter(item => !seed.some(existing => String(existing.id) === String(item.id)))], storage: 'shared'});
        } catch {
          return json({items: catalogSeed, storage: 'unavailable', warning: 'Não foi possível carregar os cadastros da equipe agora. Tente novamente em instantes.'});
        }
      }

      if ((path === '/api/emotes' || path === '/api/validate') && request.method === 'POST') {
        if (!user) return fail('Entre na sua conta para adicionar emotes à biblioteca da equipe.', 401);
        let body;
        try { body = await bodyOf(request); } catch (error) { return fail(error.message, error.status || 400, error.code); }
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
        if (!Array.isArray(body.tags) || body.tags.length < 1 || body.tags.length > 10 || body.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.trim().length > 30)) return fail('Adicione de 1 a 10 palavras-chave, com até 30 caracteres cada.');
        if (seed.some(item => String(item.id) === id)) return fail('Este emote já está na biblioteca. Busque pelo ID para encontrá-lo.', 409);
        try {
          const existing = await env.DB.prepare('SELECT id FROM emotes WHERE id = ?').bind(id).first();
          if (existing) return fail('Este emote já foi adicionado pela equipe. Busque pelo ID para encontrá-lo.', 409);
        } catch { return fail('Não foi possível acessar o catálogo compartilhado. Tente novamente em instantes.', 503); }
        let profile;
        try { profile = await readProfile(env.DB, user.id); }
        catch { return fail('Não foi possível carregar seu perfil para identificar esta contribuição. Tente novamente em instantes.', 503); }
        const checked = await verifyRoblox(id, fetcher);
        if (checked.error) return fail(checked.error, checked.status);
        const createdAt = new Date().toISOString();
        const item = {...checked.item, category: body.category, description, tags: [...new Set(body.tags.map(tag => tag.trim().toLowerCase()))], addedBy: profile?.displayName || user.name, createdAt, verifiedAt: createdAt.slice(0, 10), testedInGame: false};
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
        'Cache-Control': /\.(png|webp|jpg|woff2)$/.test(key) ? 'public, max-age=3600' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      }});
  }
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      const origins = new Set([url.origin, 'https://fernandesxz011.github.io']);
      for (const configured of String(env.ALLOWED_ORIGINS || '').split(',')) {
        try {
          const parsed = new URL(configured.trim());
          if (parsed.protocol === 'https:' && parsed.origin === configured.trim()) origins.add(parsed.origin);
        } catch { /* Ignore malformed deployment configuration. */ }
      }
      const allowed = !origin || origins.has(origin);
      const cors = response => {
        const headers = new Headers(response.headers);
        if (origin && origins.has(origin)) {
          headers.set('Access-Control-Allow-Origin', origin);
          headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          headers.set('Access-Control-Expose-Headers', 'Retry-After');
        }
        headers.set('Vary', 'Origin');
        return new Response(response.body, {status: response.status, headers});
      };
      if (request.method === 'OPTIONS') return cors(allowed ? new Response(null, {status: 204, headers: {'Access-Control-Max-Age': '600'}}) : fail('Origem não permitida.', 403));
      if (!allowed && !['GET', 'HEAD'].includes(request.method)) return cors(fail('Esta solicitação veio de outro site. Abra o Emote Club e tente novamente.', 403));
      try { return cors(await handleRequest(request, env)); }
      catch (error) {
        if (error instanceof AuthError) {
          const response = fail(error.message, error.status, error.code);
          if (error.retryAfter) response.headers.set('Retry-After', String(error.retryAfter));
          return cors(response);
        }
        return cors(fail('Não foi possível acessar os dados agora. Tente novamente em instantes.', 503));
      }
    },
  };
}
