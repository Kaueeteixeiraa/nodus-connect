# Protocolo

Versao inicial: `1`.

Mensagens de controle usam JSON validado. Dados frequentes, como frames de video e blocos de arquivo, devem usar canal binario.

Envelope:

```json
{
  "protocolVersion": 1,
  "messageType": "HEARTBEAT",
  "sessionId": "uuid",
  "timestamp": "2026-08-11T16:00:00.000Z",
  "payload": {}
}
```

Tipos iniciais:

- `HELLO`
- `AUTH`
- `CONNECTION_REQUEST`
- `CONNECTION_ACCEPT`
- `CONNECTION_DENY`
- `SESSION_START`
- `VIDEO_FRAME`
- `INPUT_EVENT`
- `FILE_TRANSFER`
- `CLIPBOARD`
- `HEARTBEAT`
- `DISCONNECT`

Regras:

- Nodus ID localiza dispositivo, nao autentica.
- `VIDEO_FRAME` e `FILE_TRANSFER` nao devem trafegar como JSON.
- Toda mensagem de sessao precisa `sessionId`.
- Eventos de entrada so sao aceitos com permissao ativa.
