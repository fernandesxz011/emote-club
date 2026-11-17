# Emote Club

Catálogo compartilhado de emotes Roblox, com coleção pessoal e cadastro de novos itens.

## GitHub Pages

O GitHub Pages hospeda a interface e o acervo inicial. Login, sessões, emotes adicionados e coleções pessoais usam a API hospedada separadamente; esses dados não entram no pacote público.

1. Em **Settings → Pages**, selecione **GitHub Actions** como origem da publicação.
2. O workflow `.github/workflows/pages.yml` publica alterações da branch `main`. Também pode ser iniciado em **Actions → Publicar Emote Club no GitHub Pages → Run workflow**.
3. A API padrão é `https://emote-club-studio.fernandesxz011.chatgpt.site`. Para trocar, crie a variável de repositório `EMOTECLUB_API_BASE_URL` em **Settings → Secrets and variables → Actions → Variables**. Use somente a origem HTTPS pública, sem senha, token ou caminho.
4. Configure a API para aceitar a origem exata do GitHub Pages. A API deve estar acessível aos visitantes do site; o Pages não remove uma eventual restrição de acesso da hospedagem da API.

Para gerar o pacote localmente:

```sh
npm run build:pages
node --test tests/pages.mjs
```

O resultado fica em `pages/`, com `config.js` gerado apenas com a URL pública da API. O build copia uma lista limitada de arquivos estáticos e imagens/fontes. Código do servidor, `.openai`, migrações e arquivos de ambiente não são publicados.

Os caminhos estáticos são relativos para funcionar tanto no domínio principal quanto em uma URL de projeto como `https://usuario.github.io/emote-club/`. Sem a API disponível, o acervo inicial continua consultável; funções de conta e colaboração precisam da conexão.
