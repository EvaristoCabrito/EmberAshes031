# Mapas salvos

Mapas feitos no Map Editor, um arquivo por save:

    <cenário>-<serial>.json      vau-001.json, vau-002.json, passo-do-corvo-001.json

O nome do arquivo é o id do cenário — é assim que um mapa é achado de novo. O serial tem
três dígitos, igual às variantes de arte (plains001.png), e nunca é sobrescrito: cada
"Salvar" grava o próximo número. Pra voltar atrás, apague o arquivo mais novo — o serial
anterior volta a valer sozinho.

O jogo carrega o **maior serial** de cada cenário (`src/game/mapstore.ts`). Um mapa cujo id
bate com uma missão da campanha substitui aquela missão; um id novo entra como missão nova.
Quando o mapa tem `locationId`, ele aparece naquele ponto do mapa-múndi.

Quem escreve os arquivos é o `npm run dev` — o editor manda o mapa pra rota
`/__map-save` (`scripts/map-save-plugin.mjs`). Sem o servidor de dev rodando não há repo
pra gravar, e o editor avisa que salvou só no navegador.

Nada aqui passa pelas passadas procedurais do `data.ts` (`rockifyColumns`,
`decorateOpenTerrain`): mapa arrumado à mão carrega exatamente como foi arrumado.
