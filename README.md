# Emote Club

Catálogo compartilhado de emotes Roblox, com coleção pessoal e cadastro de novos itens.

## GitHub Pages

O GitHub Pages hospeda a interface e o acervo inicial. Login, sessões, emotes adicionados e coleções pessoais usam a API hospedada separadamente; esses dados não entram no pacote público.

1. Em **Settings → Pages → Build and deployment → Source**, selecione **Deploy from a branch**.
2. Em **Branch**, selecione **gh-pages**, pasta **/ (root)**, e clique **Save**. Essa branch já contém o site estático completo.
3. O site será publicado em `https://fernandesxz011.github.io/emote-club/`.
4. A API padrão é `https://emote-club-studio.fernandesxz011.chatgpt.site`. O cadastro usa usuário e senha do Emote Club; marcar **Lembrar neste computador** mantém a sessão por até 30 dias, sem guardar a senha. Sem marcar, a sessão dura no máximo 12 horas e fica na aba atual.

A branch `main` contém o código-fonte. A branch `gh-pages` contém somente os arquivos públicos gerados. O workflow `.github/workflows/pages.yml` fica disponível para execução manual caso o repositório seja configurado futuramente para publicação via GitHub Actions; ele não concorre automaticamente com a publicação pela branch.

Para gerar o pacote localmente:

```sh
npm run build:pages
node --test tests/pages.mjs
```

O resultado fica em `pages/`, com `config.js` gerado apenas com a URL pública da API. O build copia uma lista limitada de arquivos estáticos e imagens/fontes. Código do servidor, `.openai`, migrações e arquivos de ambiente não são publicados.

Os caminhos estáticos são relativos para funcionar tanto no domínio principal quanto em uma URL de projeto como `https://usuario.github.io/emote-club/`. Sem a API disponível, o acervo inicial continua consultável; funções de conta e colaboração precisam da conexão.
