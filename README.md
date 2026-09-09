# LeadFlow — CRM de prospecção da LM Studio

CRM simples para trabalhar uma fila de prospecção sem perder tempo navegando por várias telas.

## O que mudou nesta versão

A base principal deixou de ficar presa ao navegador.

- Supabase Auth para login;
- Supabase Database para leads compartilhados;
- RLS para impedir acesso sem autenticação;
- Realtime para refletir alterações entre computadores;
- histórico de atividades por lead;
- mensagens e score sincronizados;
- migração automática da antiga base local quando a nuvem estiver vazia;
- Apify protegido por Supabase Edge Function;
- token do Apify fora do JavaScript e do `localStorage`.

## Fluxo comercial preservado

```text
Prospectar
→ abrir WhatsApp
→ marcar automaticamente como enviado
→ próximo lead
→ resposta
→ follow-up
→ proposta
→ fechamento
```

O objetivo continua sendo poucos cliques para executar a prospecção.

## Estrutura

```text
crmprospeccao-main/
├── index.html
├── README.md
├── SUPABASE_SETUP.md
├── exemplo_apify.csv
├── css/
│   └── style.css
├── js/
│   ├── app.js
│   └── supabase-config.js
└── supabase/
    ├── schema.sql
    └── functions/
        └── apify-proxy/
            └── index.ts
```

## Antes de rodar

Siga `SUPABASE_SETUP.md`.

Depois rode localmente, por exemplo:

```bash
python -m http.server 5500
```

E abra `http://localhost:5500`.

## Segurança

Nunca coloque no projeto:

- `service_role` do Supabase;
- senha do banco;
- token privado do Apify.

No frontend entram apenas a Project URL e a chave `anon/public` do Supabase. A proteção dos registros é feita pelo Auth + RLS. O token do Apify é configurado como secret da Edge Function.
