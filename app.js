'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const categories = [
 {name:'Feliz',emoji:'☺',color:'#c4c177',bg:'#f0efdb',ink:'#8d8841'},
 {name:'Muito feliz',emoji:'✦',color:'#cfb765',bg:'#f5edcf',ink:'#9d8036'},
 {name:'Triste',emoji:'☂',color:'#8aa7cf',bg:'#e7edf6',ink:'#738baa'},
 {name:'Muito triste',emoji:'☁',color:'#8b92bf',bg:'#e8e8f1',ink:'#7a7b9b'},
 {name:'Confirmação',emoji:'✓',color:'#a2b78b',bg:'#e7eddf',ink:'#7d8d63'},
 {name:'Negação',emoji:'×',color:'#cda18e',bg:'#f2e6e1',ink:'#ab8778'},
 {name:'Raiva',emoji:'ϟ',color:'#c78c8b',bg:'#f4e2e1',ink:'#b47b79'},
 {name:'Surpresa',emoji:'✧',color:'#b79ac6',bg:'#efe5f3',ink:'#9e80ad'},
 {name:'Dança',emoji:'♫',color:'#a694cb',bg:'#ede7f6',ink:'#8e76b3'},
 {name:'Cumprimentos',emoji:'✌',color:'#d0ac80',bg:'#f3e9db',ink:'#aa8b65'},
 {name:'Descanso',emoji:'☾',color:'#93b3ad',bg:'#e3eeeb',ink:'#74918b'},
 {name:'Medo',emoji:'!',color:'#a9a69f',bg:'#ebe9e4',ink:'#8b867e'},
 {name:'Confiança',emoji:'↗',color:'#9eabc3',bg:'#e8ecf5',ink:'#7b88a2'}
];
const categoryOf = name => categories.find(c => c.name === name) || categories[0];
let savedFavorites;
try { savedFavorites = JSON.parse(localStorage.getItem('emoteclub-favorites') || '[]'); } catch { savedFavorites = []; }
const state = {items:[],view:'all',category:'all',query:'',sort:'curated',favorites:new Set(Array.isArray(savedFavorites) ? savedFavorites.map(String) : []),storage:'loading',user:null,detailId:null};
let toastTimer;
function toast(message) { const el = $('#toast'); $('span', el).textContent = message; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => {el.hidden = true;}, 3600); }
function safeImage(url) { return typeof url === 'string' && (/^\/assets\/[a-zA-Z0-9-]+\.png$/.test(url) || /^https:\/\/[^/]+\.rbxcdn\.com\//.test(url)) ? url : '/assets/emote-4849499887.png'; }
function cardStyles(c) { return `--card-bg:${c.bg};--tag-bg:${c.bg};--tag-ink:${c.ink}`; }
function catalogLink(item) { return `https://www.roblox.com/catalog/${encodeURIComponent(item.id)}`; }
function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog) { dialog.close(); }
function counts(category) { return state.items.filter(item => item.category === category).length; }
function renderNavigation() {
 $('#nav-count').textContent = state.items.length;
 $('#fav-count').textContent = state.items.filter(item => state.favorites.has(item.id)).length;
 $('#hero-count').textContent = `${state.items.length} emotes`;
 $('#sidebar-categories').innerHTML = categories.map(c => `<button class="category-item ${state.category===c.name?'active':''}" data-category="${c.name}" style="--cat-color:${c.color}" aria-pressed="${state.category===c.name}"><span class="cat-dot"></span>${c.name}<span class="cat-count">${counts(c.name)}</span></button>`).join('');
 $('#category-filters').innerHTML = `<button class="filter-pill ${state.category==='all'?'active':''}" data-category="all" aria-pressed="${state.category==='all'}">Todos os emotes <span class="pill-count">${state.items.length}</span></button>` + categories.map(c => `<button class="filter-pill ${state.category===c.name?'active':''}" data-category="${c.name}" aria-pressed="${state.category===c.name}"><span class="emoji">${c.emoji}</span>${c.name}</button>`).join('');
 $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view===state.view));
}
function filteredItems() {
 const query = normalize(state.query).trim();
 const items = state.items.filter(item => (state.category==='all'||item.category===state.category) && (state.view!=='favorites'||state.favorites.has(item.id)) && (state.view!=='added'||item.createdAt) && (!query||normalize([item.name,item.category,item.description,item.id,...item.tags].join(' ')).includes(query)));
 if (state.sort==='name') items.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
 if (state.sort==='recent') items.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
 return items;
}
function renderCard(item,index) {
 const c = categoryOf(item.category), favorite = state.favorites.has(item.id);
 return `<article class="emote-card" style="${cardStyles(c)}"><div class="card-image"><span class="card-index">EC / ${String(index+1).padStart(2,'0')}</span><button class="favorite-button ${favorite?'is-favorite':''}" data-favorite="${item.id}" aria-label="${favorite?'Remover':'Adicionar'} ${escapeHTML(item.name)} ${favorite?'dos':'aos'} favoritos" aria-pressed="${favorite}">${icon('heart')}</button><button class="detail-trigger" data-detail="${item.id}" aria-label="Ver detalhes de ${escapeHTML(item.name)}"><img src="${escapeHTML(safeImage(item.thumbnail))}" alt="Miniatura do emote ${escapeHTML(item.name)}" loading="lazy" width="420" height="420"></button><span class="image-caption">MAKE A SCENE.</span></div><div class="card-body"><span class="card-category">${c.emoji} ${escapeHTML(item.category)}</span><button class="card-name" data-detail="${item.id}" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</button><p class="card-description">${escapeHTML(item.description)}</p><div class="card-footer"><span class="verified-label" title="ID e tipo Emote conferidos no catálogo oficial. Não testado em jogo.">${icon('check')}Catálogo conferido</span><button class="copy-button" data-copy="${item.id}" aria-label="Copiar ID de ${escapeHTML(item.name)}">${icon('copy')}Copiar ID</button></div></div></article>`;
}
function render() {
 renderNavigation();
 const items=filteredItems();
 $('#results-count').textContent = `${items.length} ${items.length===1?'emote encontrado':'emotes encontrados'}`;
 $('#emote-grid').innerHTML=items.map(renderCard).join('');
 $('#empty-state').hidden=items.length>0;
 const noFilter=state.category==='all'&&!state.query;
 $('#clear-filters').hidden=noFilter;
 $('#empty-description').textContent=state.view==='favorites'&&noFilter?'Toque no coração de um emote para guardar suas reações favoritas neste navegador.':state.view==='added'&&noFilter?'O próximo achado pode ser seu. Adicione um novo emote para compartilhar com a equipe.':'Experimente outra palavra ou explore uma nova emoção.';
 $('#catalog-title').innerHTML=state.view==='favorites'?'Suas reações favoritas<span class="heading-dot">.</span>':state.view==='added'?'Descobertas da equipe<span class="heading-dot">.</span>':'Encontre sua próxima reação<span class="heading-dot">.</span>';
 $('#breadcrumb-view').textContent={all:'Explorar emotes',favorites:'Favoritos',added:'Adicionados pela equipe'}[state.view];
 $('#hero').hidden=state.view!=='all';
}
function setCategory(category) {state.category=category;state.view='all';render();$('#sidebar').classList.remove('mobile-open');}
function setView(view) {state.view=view;state.category='all';state.query='';$('#search').value='';render();$('#sidebar').classList.remove('mobile-open');}
function reset() {setView('all');}
function favorite(id) {
 if(state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
 try {localStorage.setItem('emoteclub-favorites',JSON.stringify([...state.favorites]));} catch {toast('Favorito marcado. Seu navegador não permitiu salvar a preferência.');}
 render();
 if(state.detailId===id && $('#detail-dialog').open) showDetail(id,false);
}
async function copyId(id) {
 try { await navigator.clipboard.writeText(id); toast('ID do catálogo copiado. Bora gravar!'); }
 catch { const field=document.createElement('textarea');field.value=id;field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();const copied=document.execCommand('copy');field.remove();toast(copied?'ID do catálogo copiado.':`ID do catálogo: ${id}`); }
}
function showDetail(id,open=true) {
 const item=state.items.find(i=>i.id===id); if(!item)return;
 state.detailId=id;const c=categoryOf(item.category),fav=state.favorites.has(id);
 $('#detail-content').innerHTML=`<div class="detail-layout" style="${cardStyles(c)}"><div class="detail-image"><img src="${escapeHTML(safeImage(item.thumbnail))}" alt="Emote ${escapeHTML(item.name)}"></div><section class="detail-info"><span class="card-category">${c.emoji} ${escapeHTML(item.category)}</span><h2>${escapeHTML(item.name)}</h2><p class="detail-creator">Por ${escapeHTML(item.creator)}${item.addedBy?` · adicionado por ${escapeHTML(item.addedBy)}`:''}</p><p>${escapeHTML(item.description)}</p><div class="detail-tags">${item.tags.map(tag=>`<span>#${escapeHTML(tag)}</span>`).join('')}</div><div class="id-block"><div><small>ID DO CATÁLOGO</small><code>${escapeHTML(id)}</code></div><button class="icon-button" data-copy="${id}" aria-label="Copiar ID">${icon('copy')}</button></div><div class="detail-buttons"><a class="button primary" href="${catalogLink(item)}" target="_blank" rel="noopener noreferrer">Ver emote no Roblox ${icon('external')}</a><button class="button ghost" data-favorite="${id}">${icon('heart')}${fav?'Remover dos favoritos':'Salvar nos favoritos'}</button></div><p class="detail-disclaimer">✓ ID e tipo Emote conferidos no catálogo${item.verifiedAt?` em ${escapeHTML(item.verifiedAt.split('-').reverse().join('/'))}`:''}. Prévia animada, preço e disponibilidade na página oficial. Teste na sua experiência antes de gravar.</p></section></div>`;
 if(open) openDialog($('#detail-dialog'));
}
function openAdd() {
 $('#sidebar').classList.remove('mobile-open');
 const error=$('#form-error');error.hidden=true;
 if(state.storage!=='shared') {error.textContent='O cadastro compartilhado está temporariamente indisponível. Você pode explorar os emotes enquanto isso.';error.hidden=false;}
 $('#save-emote').disabled=state.storage!=='shared';
 openDialog($('#add-dialog'));
}
async function requestJSON(path,options={}) {
 const response=await fetch(path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},signal:AbortSignal.timeout(20000)});
 let data;try {data=await response.json();} catch {throw new Error('Não foi possível ler a resposta do servidor. Tente novamente.');}
 if(!response.ok) { const error=new Error(data.error||'Algo deu errado. Tente novamente.');error.status=response.status;throw error;}
 return data;
}
function formError(message,status) {
 const el=$('#form-error');el.textContent=message;
 if(status===401){const link=document.createElement('a');link.href='/signin-with-chatgpt?return_to=/';link.target='_top';link.textContent=' Entrar com ChatGPT ↗';link.style.textDecoration='underline';el.append(link);}
 el.hidden=false;
}
async function validateEmote() {
 const button=$('#validate-emote');const input=$('#emote-id');
 if(!input.value.trim()) {input.reportValidity();return;}
 button.disabled=true;button.textContent='Conferindo…';$('#form-error').hidden=true;$('#validation-result').hidden=true;
 try {const {item}=await requestJSON('/api/validate',{method:'POST',body:JSON.stringify({id:input.value.trim()})});$('#emote-name').value=item.name;const result=$('#validation-result');result.textContent=`✓ ${item.name} · Por ${item.creator}. ID e tipo Emote conferidos no Roblox.`;result.hidden=false;}
 catch(error){formError(error.name==='TimeoutError'?'O Roblox demorou a responder. Tente conferir novamente.':error.message,error.status);}
 finally {button.disabled=false;button.textContent='Conferir';}
}
async function saveEmote(event) {
 event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;
 const submit=$('#save-emote');submit.disabled=true;submit.innerHTML='Salvando…';$('#form-error').hidden=true;
 const fields=new FormData(form),payload={id:fields.get('id').trim(),name:fields.get('name').trim(),category:fields.get('category'),description:fields.get('description').trim(),tags:fields.get('tags').split(',').map(tag=>tag.trim()).filter(Boolean)};
 try {const {item}=await requestJSON('/api/emotes',{method:'POST',body:JSON.stringify(payload)});state.items.push(item);closeDialog($('#add-dialog'));form.reset();$('#validation-result').hidden=true;setView('added');toast('Nova reação no acervo. A equipe agradece!');}
 catch(error){formError(error.name==='TimeoutError'?'A resposta demorou mais que o esperado. Busque pelo ID antes de tentar salvar novamente.':error.message,error.status);}
 finally {submit.disabled=false;submit.innerHTML=`${icon('plus')}Adicionar ao acervo`;}
}
document.addEventListener('click',event=>{
 const category=event.target.closest('[data-category]');if(category){setCategory(category.dataset.category);return;}
 const view=event.target.closest('[data-view]');if(view){setView(view.dataset.view);return;}
 const fav=event.target.closest('[data-favorite]');if(fav){favorite(fav.dataset.favorite);return;}
 const copy=event.target.closest('[data-copy]');if(copy){copyId(copy.dataset.copy);return;}
 const detail=event.target.closest('[data-detail]');if(detail){showDetail(detail.dataset.detail);return;}
 if(event.target.closest('[data-add]')){openAdd();return;}
 const close=event.target.closest('[data-close]');if(close){closeDialog(close.closest('dialog'));return;}
 if(!event.target.closest('.sidebar')&&!event.target.closest('#mobile-menu')) $('#sidebar').classList.remove('mobile-open');
});
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
$('#search').addEventListener('input',event=>{state.query=event.target.value;render();});
$('#sort').addEventListener('change',event=>{state.sort=event.target.value;render();});
$('#clear-filters').addEventListener('click',()=>{state.category='all';state.query='';$('#search').value='';render();});
$('#empty-reset').addEventListener('click',reset);
$('#surprise').addEventListener('click',()=>{const items=filteredItems();if(!items.length){toast('Explore todos os emotes para encontrar uma surpresa.');return;}showDetail(items[Math.floor(Math.random()*items.length)].id);});
$('#open-guide').addEventListener('click',()=>openDialog($('#guide-dialog')));
$('#catalog-about').addEventListener('click',()=>openDialog($('#guide-dialog')));
$('#mobile-menu').addEventListener('click',()=>$('#sidebar').classList.toggle('mobile-open'));
$('#grid-view').addEventListener('click',()=>setLayout(false));$('#list-view').addEventListener('click',()=>setLayout(true));
function setLayout(list) {$('#emote-grid').classList.toggle('list-mode',list);$('#grid-view').classList.toggle('active',!list);$('#list-view').classList.toggle('active',list);$('#grid-view').setAttribute('aria-pressed',String(!list));$('#list-view').setAttribute('aria-pressed',String(list));}
$('#emote-category').innerHTML=categories.map(c=>`<option value="${c.name}">${c.name}</option>`).join('');
$('#validate-emote').addEventListener('click',validateEmote);
$('#add-form').addEventListener('submit',saveEmote);
$('#emote-id').addEventListener('input',()=>{$('#validation-result').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$$('dialog').some(d=>d.open)){event.preventDefault();$('#search').focus();}});
async function load() {
 try {const data=await requestJSON('/api/emotes');state.items=data.items;state.storage=data.storage;if(data.warning){$('#catalog-status').textContent=data.warning;$('#catalog-status').hidden=false;}}
 catch {try {state.items=await (await fetch('/seed.json')).json();state.storage='unavailable';$('#catalog-status').textContent='Exibindo o acervo inicial. Não foi possível conectar aos cadastros da equipe. Atualize a página para tentar novamente.';$('#catalog-status').hidden=false;}catch{$('#catalog-status').textContent='Não foi possível carregar a biblioteca. Atualize a página para tentar novamente.';$('#catalog-status').hidden=false;state.items=[];}}
 render();
}
load();
requestJSON('/api/me').then(user=>{state.user=user;if(user.name){const initials=user.name.split(/[ @._-]/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase();$('#user-avatar').textContent=initials;$('#user-avatar').title=user.name;}}).catch(()=>{});
