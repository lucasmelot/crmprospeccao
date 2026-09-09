# Configuração do Supabase — LeadFlow

O CRM foi preparado para usar o Supabase como fonte principal dos dados. Os leads não dependem mais do `localStorage`.

## 1. Criar projeto

Crie um projeto no Supabase e aguarde o banco ficar disponível.

## 2. Criar banco e RLS

Abra **SQL Editor**, cole todo o conteúdo de `supabase/schema.sql` e execute.

Esse SQL cria:

- `leads` — base compartilhada;
- `activities` — histórico por lead;
- `app_settings` — mensagens e pesos do score;
- políticas RLS que exigem login;
- Realtime para atualizar outros computadores.

## 3. Criar seu usuário

Em **Authentication > Users**, crie seu usuário de acesso.

Para este MVP, mantenha o cadastro público de novos usuários desativado. Quando outra pessoa for trabalhar na prospecção, crie o usuário dela manualmente no painel do Supabase.

## 4. Configurar o frontend

Abra `js/supabase-config.js` e preencha:

```js
window.LEADFLOW_SUPABASE = {
  url: "https://SEU-PROJETO.supabase.co",
  anonKey: "SUA_CHAVE_PUBLICA_ANON"
};
```

Use somente a URL do projeto e a chave **anon/public**. Nunca coloque `service_role` no frontend.

## 5. Proteger o token do Apify

A busca do Apify agora passa por uma Supabase Edge Function. O token não fica no navegador.

Crie o secret no Supabase:

```bash
supabase secrets set APIFY_TOKEN=apify_api_SEU_TOKEN
```

Depois faça deploy da função existente em:

```text
supabase/functions/apify-proxy/index.ts
```

Com a CLI:

```bash
supabase functions deploy apify-proxy
```

A função exige um usuário autenticado no CRM e usa `APIFY_TOKEN` somente no servidor.

## 6. GitHub Pages

Depois de preencher `js/supabase-config.js`, o projeto pode continuar hospedado no GitHub Pages. A chave `anon/public` pode estar no frontend porque a segurança dos dados é feita pelas políticas RLS.

## Migração automática da versão antiga

No primeiro login, se a nuvem estiver vazia e o navegador ainda possuir a antiga base `leadflow_local_v1`, o CRM envia esses leads para o Supabase e remove a cópia antiga usada como fonte principal.

## Arquitetura

```text
GitHub Pages / navegador
        |
        | Supabase Auth + chave pública
        v
Supabase Database (RLS)
        |
        +--> leads
        +--> activities
        +--> app_settings

Busca Google Maps:
Navegador autenticado
        |
        v
Supabase Edge Function
        |
        | secret APIFY_TOKEN
        v
Apify API
```
