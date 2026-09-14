# Seguranca

Principios:

- Consentimento visivel sempre.
- Sem sessao escondida.
- Nodus ID nao e segredo.
- Nao criar criptografia propria.
- Nao registrar senhas, tokens, chaves privadas ou conteudo remoto.

Fase 1:

- Gera Nodus ID persistente para identificacao local.
- Nao implementa controle remoto nem acesso nao supervisionado.
- Marca recursos sensiveis como pendentes.

Fases seguintes:

- Chave do dispositivo em armazenamento seguro do SO.
- Autenticacao mutua de sessao.
- Tokens temporarios com expiracao.
- Protecao contra replay.
- Rate limiting em coordenacao/auth.
- Logs separados: `application.log`, `connection.log`, `security.log`, `error.log`.
- Dispositivos confiaveis baseados em credenciais criptograficas, nao apenas ID.
