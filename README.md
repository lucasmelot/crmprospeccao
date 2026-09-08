# LeadFlow v4 — CRM local + Apify API

Esta versão elimina a etapa de abrir o Apify, exportar um arquivo e depois importar no CRM.

## Fluxo novo

1. Abra **Buscar Maps**.
2. Cole seu **API Token do Apify**.
3. Digite as pesquisas, uma por linha.
4. Informe a localização.
5. Clique em **Buscar no Google Maps**.
6. O LeadFlow:
   - inicia o Actor `compass/crawler-google-places`;
   - acompanha o Run pela API;
   - espera a execução terminar;
   - baixa o dataset;
   - converte os resultados em leads;
   - remove/mescla duplicatas;
   - joga tudo direto na fila de prospecção.

Depois é só usar:

**Prospectar → Enviar no WhatsApp → próximo lead.**

## API usada

O projeto usa a API REST v2 do Apify.

Fluxo:

- `POST /v2/actors/{actorId}/runs`
- `GET /v2/actor-runs/{runId}`
- `GET /v2/datasets/{datasetId}/items`

A autenticação é enviada no header:

```text
Authorization: Bearer SEU_TOKEN
```

O token não é enviado em query string.

## Google Maps Scraper

Actor padrão:

```text
compass~crawler-google-places
```

Campos usados na busca:

- `searchStringsArray`
- `locationQuery`
- `maxCrawledPlacesPerSearch`
- `language`
- `website`
- `skipClosedPlaces`
- `scrapePlaceDetailPage`
- `maxReviews: 0`
- enriquecimentos extras desativados

Isso foi configurado para prospecção, evitando coletar reviews completas, imagens, redes sociais ou enriquecimento de leads sem necessidade.

## Token

Por padrão, se você não marcar **Lembrar token neste navegador**, ele fica apenas no `sessionStorage` da aba/sessão.

Se marcar a opção, ele será gravado no `localStorage` do navegador.

O token:
- não entra no backup JSON do CRM;
- não entra no CSV;
- não é colocado no código-fonte.

Em computador compartilhado, não use a opção de lembrar.

## Custos

O LeadFlow continua gratuito e local.

Porém, as execuções feitas no Apify usam os créditos/limites da sua conta Apify. A interface mostra uma estimativa máxima de quantidade de resultados antes da execução.

## Importação manual

A importação CSV/XLSX continua disponível como fallback em:

**Buscar Maps → Prefiro importar um arquivo CSV/XLSX manualmente**

## Exportação

Você pode:
- exportar todos os leads na tela **Leads**;
- exportar somente a última busca feita via Apify na própria tela **Buscar Maps**.

## Como rodar

Recomendado:

```bash
python -m http.server 5500
```

Depois abra:

```text
http://localhost:5500
```

Rodar por HTTP local é preferível a abrir diretamente `file://`, principalmente para chamadas externas de API.

## Estrutura

```text
leadflow_crm_v4/
├── index.html
├── README.md
├── exemplo_apify.csv
├── css/
│   └── style.css
└── js/
    └── app.js
```
