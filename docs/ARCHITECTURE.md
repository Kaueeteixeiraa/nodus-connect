# Arquitetura

## Implementacao atual

- `apps/desktop`: Electron, Chromium, React e Vite.
- `services/coordination`: presenca, lookup e sinalizacao.
- `services/relay`: fallback TURN/WebRTC quando a conexao direta falha.
- `packages/protocol`: mensagens versionadas.
- `packages/common`: validacao, IDs e utilitarios compartilhados.
- `native`: entrada remota e verificacao da captura WGC/encoders do Windows.

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

## Pipeline de video e desempenho

O caminho principal permanece sem canvas ou recodificacao intermediaria:

`getDisplayMedia (WGC no Chromium) -> encoder WebRTC -> ICE P2P/TURN -> decoder Chromium -> video`

- O controlador coleta `RTCStats` a cada 500 ms e ajusta bitrate, escala e FPS no sender existente.
- A interface recebe uma amostra consolidada a cada 1 segundo para evitar renderizacoes React desnecessarias.
- A degradacao preserva 60 FPS em 1080p, 900p e 720p antes de reduzir para 45/30 FPS.
- A recuperacao ocorre gradualmente depois de varias amostras estaveis.
- O inspetor usa media movel para apontar `CAPTURE`, `ENCODER`, `NETWORK`, `DECODER`, `RENDER`, `NONE` ou `UNKNOWN`.
- Tela estatica e aquecimento sem dados suficientes sao classificados como `UNKNOWN`, evitando conclusoes falsas.

O relatorio de laboratorio pode ser gerado com:

`node scripts/perf-lab.mjs report <performance.log> --duration=60`

## Riscos

- Captura eficiente no Windows exige API nativa e testes de latencia.
- Controle remoto precisa isolamento forte por permissao.
- Relay pode concentrar custo de banda.
- Acesso nao supervisionado exige armazenamento seguro de credenciais, rate limit e auditoria.
