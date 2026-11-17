# Conferência do acervo — 17/11/2026

O catálogo contém 195 IDs distintos, com 15 por categoria. Os 40 IDs anteriores foram preservados. Os 155 itens acrescentados são novas entradas no Emote Club; a data de entrada não é a data de lançamento no Roblox.

## Critérios aplicados

- ID, nome e criador obtidos no catálogo oficial; tipo `EmoteAnimation` (61).
- Preço listado, sem indicação de moderação, restrição ou Off Sale nas respostas consultadas. `isPurchasable` só é registrado quando a API o fornece expressamente. Preço listado e compra confirmada são evidências distintas.
- Miniatura oficial com estado `Completed`; todos os 195 PNGs locais têm 420×420 pixels, CRC válido e dados íntegros.
- ID do emote e payload consultados na API pública Asset Delivery. Quando acessíveis, o arquivo do emote foi lido, sua referência `AnimationId` extraída e o arquivo de animação tipo24 consultado e baixado.
- 46 itens passaram pela conferência pública completa dos arquivos. Os outros149 exigem autenticação do Roblox para acessar o arquivo. Uma resposta401 não prova que o emote esteja quebrado.
- Nenhum item foi executado dentro de uma experiência durante esta conferência. Todos mantêm `testedInGame:false`.

As categorias e descrições de uso são curadoria editorial. Elas não são uma classificação oficial do Roblox, nem uma medição de intensidade emocional.

## Evidência e reprodução

`catalog-audit.json` contém as observações por ID, fontes estáveis, datas, respostas de status, tamanhos e hashes dos arquivos públicos. Não contém tokens de autenticação nem URLs CDN assinadas.

Para repetir somente a conferência pública dos arquivos:

```sh
python scripts/audit-public-emotes.py seed.json --output catalog-delivery-audit.json --workers 2
```

O script respeita `Retry-After`, mantém cache por ID e não simula uma execução no Roblox. Use `--refresh` para renovar resultados existentes.

## Fontes oficiais

- Catálogo: `https://catalog.roblox.com/v1/catalog/items/ID/details?itemType=Asset` e o endpoint batch `POST /v1/catalog/items/details`.
- Miniaturas: `https://thumbnails.roblox.com/v1/assets`.
- Asset Delivery: `https://assetdelivery.roblox.com/v2/assetId/ID` e `https://assetdelivery.roblox.com/v1/asset/?id=ID`.
- [Emotes na experiência](https://create.roblox.com/docs/characters/emotes).
- [Especificações de emotes](https://create.roblox.com/docs/avatar/emotes/specifications).
