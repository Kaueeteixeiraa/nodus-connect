# Deploy

Ainda nao ha deploy de producao.

Plano:

- Empacotar cliente Windows via Tauri.
- Assinar binarios e instalador.
- Publicar Coordination/Auth/Relay em infraestrutura separada.
- TLS obrigatorio em APIs.
- TURN/relay com credenciais efemeras.
- Atualizacao automatica somente com verificacao de assinatura e integridade.

## Release Windows

- `pnpm installer:build` gera setup e QuickSupport da mesma versao e valida seus binarios, chave publica e hashes.
- Enviar ambos os executaveis e seus arquivos `.sha256` ao mesmo release do GitHub.
- Atualizar `NODUS_SUPPORT_TEMPLATE_VERSION` e `NODUS_SUPPORT_TEMPLATE_SHA256` na API de licencas e aplicar em um novo deployment.
- Conferir a geracao do QuickSupport antes de marcar o release como latest e atualizar o site. Nunca publicar somente o setup.
