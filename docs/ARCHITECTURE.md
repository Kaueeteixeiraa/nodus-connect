# Arquitetura

## Decisao

O Nodus Connect deve evoluir para:

- `apps/desktop`: Tauri + Rust + UI React.
- `services/coordination`: servico Rust/Axum para presenca, lookup e sinalizacao.
- `services/relay`: relay TURN/WebRTC ou QUIC quando conexao direta falhar.
- `services/auth`: contas, dispositivos confiaveis e revogacao.
- `packages/protocol`: mensagens versionadas.
- `packages/common`: validacao, IDs e utilitarios compartilhados.

Nesta Fase 1 o ambiente local nao possui Rust instalado. Por isso, a base executavel usa React/Vite e um servidor Node em memoria, mantendo os contratos separados para migração direta para Rust/Tauri.

## Fluxo alvo

1. Cliente registra presenca temporaria no Coordination Server.
2. Outro cliente informa o Nodus ID.
3. Servidor localiza o destino e intermedeia a solicitacao.
4. Usuario remoto aceita/recusa e define permissoes.
5. Clientes autenticam a sessao com credenciais criptograficas.
6. ICE tenta P2P com STUN/TURN.
7. Se P2P falhar, usa Relay Nodus.
8. Canal seguro transmite frames, entrada, clipboard e arquivos conforme permissoes.

## Decisoes de rede

WebRTC/ICE e a escolha inicial para transporte interativo porque padroniza descoberta de candidatos, STUN/TURN e canais em tempo real. O relay existe para redes restritivas. O servidor de coordenacao nunca concede controle por conhecimento do ID.

## Riscos

- Captura eficiente no Windows exige API nativa e testes de latencia.
- Controle remoto precisa isolamento forte por permissao.
- Relay pode concentrar custo de banda.
- Acesso nao supervisionado exige armazenamento seguro de credenciais, rate limit e auditoria.
