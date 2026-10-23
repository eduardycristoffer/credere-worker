# credere-worker

Worker Playwright que pega o lead do Lovable, simula na Credere (todos os bancos) e devolve se saiu proposta.

## Fluxo
1. Lovable chama `POST /simular` (Bearer `WORKER_SECRET`) com `analise_id`, `loja_slug`, `lead`, `veiculo`, `entrada`.
2. O worker responde 202, entra na fila (uma consulta por vez, com intervalo aleatório).
3. Faz login com a conta da loja (`CREDERE_ACCOUNTS[loja_slug]`), abre `/simulations/new`, preenche o formulário dentro do iframe do embed, envia e espera os bancos responderem.
4. Devolve `{analise_id, status, bancos[], resumo}` para `LOVABLE_CALLBACK_URL`.

`status`: `com_proposta`, `sem_proposta`, `indefinido` ou `erro` (com `motivo`).

## Uma conta por loja
Variável `CREDERE_ACCOUNTS` (JSON, no Railway):

```json
{"lima-motors":{"login":"...","senha":"..."},"outra-loja":{"login":"...","senha":"..."}}
```

Chave `default` serve de fallback. Loja sem conta devolve `erro/loja_sem_conta`.

## Rotas
- `GET /health`
- `GET /lojas` (auth): slugs com conta cadastrada
- `POST /discover` `{loja_slug}` (auth): lista os campos reais do formulário, sem enviar nada
- `POST /simular` (auth)

## Segurança
- Credenciais só em variável de ambiente; nunca em log.
- CPF mascarado nos logs; telefone/CPF mascarados no texto devolvido.
- Mensagens de erro genéricas.

## Status
v0: os rótulos dos campos em `src/credere.js` (`CAMPOS`) e a leitura do resultado são estimados.
Rode `/discover` com a conta de uma loja para ajustar.

## Deploy
Railway com Dockerfile na raiz; healthcheck em `/health`.
