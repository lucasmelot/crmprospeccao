# LeadFlow v3 — CRM local de prospecção

Versão redesenhada para reduzir cliques e funcionar como uma **fila de trabalho**.

## Fluxo principal

1. Importe o CSV/XLSX do Apify.
2. A tela **Prospectar** abre os leads ainda não contatados, ordenados por score.
3. Clique em **Enviar no WhatsApp**.
4. O CRM:
   - abre o WhatsApp com a mensagem pronta;
   - marca o lead como `Mensagem enviada`;
   - registra data/hora;
   - avança automaticamente para o próximo lead.
5. Quando houver retorno, use `Respondeu`, `Follow-up +3 dias` ou `Sem interesse`.

## Atalhos

Na tela Prospectar:

- `W` = abrir WhatsApp e marcar como enviado.
- `S` = pular o lead nesta sessão.

## Importação

O sistema reconhece automaticamente:

- title / placeName / name
- phone / phoneUnformatted
- website / websiteUrl
- totalScore / rating
- reviewsCount / reviews
- categoryName / category
- city
- url / googleMapsUrl
- placeId

CSV funciona totalmente offline. XLSX usa SheetJS carregado via CDN.

## Mensagens

Existem templates diferentes para:

- lead **com site**;
- lead **sem site**.

A escolha é automática.

## Armazenamento

Os dados ficam no `localStorage` do navegador, sem servidor e sem mensalidade.

Use **Ajustes → Baixar backup** regularmente.

## Observação importante sobre WhatsApp

Ao clicar em **Enviar no WhatsApp**, o CRM abre a conversa e marca o lead como `Mensagem enviada`.

Como esta versão não usa a API oficial do WhatsApp, o sistema não consegue confirmar se você realmente apertou o botão de envio dentro do WhatsApp. Por isso, a marcação representa que a conversa foi aberta para envio.

## Como rodar

Abra `index.html`.

Recomendado:

```bash
python -m http.server 5500
```

Depois:

```text
http://localhost:5500
```
