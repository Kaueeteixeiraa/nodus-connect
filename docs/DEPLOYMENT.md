# Deploy

Ainda nao ha deploy de producao.

Plano:

- Empacotar cliente Windows via Tauri.
- Assinar binarios e instalador.
- Publicar Coordination/Auth/Relay em infraestrutura separada.
- TLS obrigatorio em APIs.
- TURN/relay com credenciais efemeras.
- Atualizacao automatica somente com verificacao de assinatura e integridade.
