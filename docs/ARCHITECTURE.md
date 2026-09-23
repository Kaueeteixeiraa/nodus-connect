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

`desktopCapturer/getDisplayMedia (Chromium) -> track MediaStream -> encoder WebRTC -> ICE P2P/TURN -> decoder Chromium -> video`

A captura seleciona uma tela via Electron; o track vai diretamente ao `RTCPeerConnection.addTrack`, sem Canvas, ImageData ou serializacao de quadros em JavaScript. A conversao de cor, o numero de copias internas e a API nativa usada pelo Chromium nessa maquina nao sao expostos pelo app. O video remoto e exibido por `<video>`; `requestVideoFrameCallback` mede os quadros apresentados somente na sessao visivel. Mouse usa DataChannel nao ordenado/sem retransmissao; cliques e teclado usam o canal confiavel. Arquivos usam outro canal. ICE seleciona candidato direto ou relay TURN, e o par selecionado determina rota e protocolo no diagnostico.

- O controlador coleta `RTCStats` a cada 500 ms e ajusta bitrate, escala e FPS no sender existente.
- A interface recebe uma amostra consolidada a cada 1 segundo para evitar renderizacoes React desnecessarias.
- Os limites de FPS sao 120, 90, 60, 45 e 30 (sempre limitados pela escolha do usuario). Queda de resolucao ocorre apenas com evidencia de pressao de rede.
- A degradacao exige quatro amostras consecutivas (exceto perda/RTT criticos), muda um nivel por vez e respeita 5 s de cooldown; a recuperacao exige 20 amostras estaveis.
- O inspetor usa media movel para apontar `CAPTURE`, `ENCODER`, `NETWORK`, `DECODER`, `RENDER`, `BUFFER_QUEUE`, `NONE` ou `UNKNOWN`.
- Tela estatica e aquecimento sem dados suficientes sao classificados como `UNKNOWN`, evitando conclusoes falsas.

O relatorio de laboratorio pode ser gerado com os logs da mesma sessao nos dois PCs:

`node scripts/perf-lab.mjs report <log-do-host> --duration=60 --peer=<log-do-cliente>`

O relatorio separa captura/encode/envio no host e recepcao/decode/render no cliente. Mostra FPS medio, 1% low durante imagem ativa, RTT P95, bitrate de pico, tempo de encode/decode P95, contadores de quadros, protocolo ICE e implementacoes de codec quando o Chromium as fornece. Campos ausentes retornam `null` ou `unknown`; `jitterBufferMs` mede apenas o buffer WebRTC e nao a fila completa de ponta a ponta. O contador de renderizacao mede apenas a sessao exibida. O 1% low em tela estatica nao e representativo.

Baseline existente (logs de teste local de 21/09/2026, 60 s, 1366x768): captura 27,8, encode/envio 27,1, recepcao 27,1, decode 27,2 e render 21,7 FPS; RTT do cliente 17,2 ms, perda 0%, buffer de jitter 191,9 ms, H.264/OpenH264 software e rota direta. Sao logs anteriores aos novos contadores e nao demonstram melhora. A causa do FPS baixo permanece indeterminada: encode P95 de 25 ms, buffer elevado e diferenca entre decode/render merecem teste isolado sob movimento constante. GPU decode, carga de CPU/GPU e numero de copias internas continuam sem medicao confiavel. Teste real entre dois PCs em 1080p60 e necessario para atribuir o gargalo.

## Fase 2: encode e decode por hardware

O Electron 43.3.0 nao desativa a aceleracao de hardware neste projeto. As flags de Media Foundation e captura WGC ja existiam no codigo; nenhuma flag nova foi adicionada. `RTCRtpSender.getCapabilities("video")` lista perfis H.264, mas nao indica qual implementacao de encoder sera usada. `setCodecPreferences()` prioriza H.264 e nao pode selecionar NVENC, QSV ou AMF diretamente. Nao ha reescrita manual de SDP. O encoder/decoder real e lido de `encoderImplementation`/`decoderImplementation` em `getStats()`. A sonda nativa enumera MFTs disponiveis, mas isso nao prova que o WebRTC os utiliza.

Em 23/09/2026, `pnpm exec electron scripts/phase2-gpu-probe.cjs` testou tres negociacoes locais em loopback: ordem anterior de codecs, ordem anunciada pelo Chromium e parametros de sender semelhantes aos do app. Nas tres, o codec negociado foi H.264 Baseline (`profile-level-id=42001f`, `packetization-mode=1`), o encoder real foi `MediaFoundationVideoEncodeAccelerator (Intel Quick Sync Video H.264 Encoder MFT)` e o decoder real foi `ExternalDecoder (D3D11VideoDecoder)`. A GPU era Intel HD Graphics 520, com `video_encode`, `video_decode` e composicao GPU habilitados. Portanto, a antiga ordem de codecs e os parametros testados nao explicam o OpenH264 do baseline. O motivo daquele fallback continua desconhecido sem uma nova sessao completa entre dois PCs.

O app agora registra status de GPU do Electron, perfis H.264 anunciados, perfil negociado, implementacoes efetivas e motivo do fallback somente quando houver evidencia. `MediaFoundation` isolado nao e classificado como prova de hardware. O relatorio combinado preserva as medidas de buffer e renderizacao; valores acima de 150 ms no buffer e render inferior a 85% do decode sao sinalizados separadamente. A prova de loopback confirma disponibilidade nesta maquina, mas nao mede ganho de FPS ou latencia em acesso remoto real.

## Fase 3: buffer e adaptacao

Na sessao de 23/09/2026, o cliente registrou P2P/UDP, RTT medio de 8 ms, perda 0%, jitter RTP medio de 168 ms, atraso de playout medio de 326 ms e 23 incrementos de `freezeCount`. So existe o log do viewer; a imagem ficou quase estatica. Esses numeros nao provam capacidade maxima de 2-3 FPS nem identificam a origem do atraso de playout.

- `jitterMs = inbound-rtp.jitter * 1000` (ou `remote-inbound-rtp.jitter` no host). E variacao de chegada RTP em segundos convertida para ms, nao latencia de rede nem contador cumulativo. Sem movimento constante, nao e evidencia isolada de congestionamento.
- `jitterBufferMs = 1000 * delta(jitterBufferDelay) / delta(jitterBufferEmittedCount)`. Os dois campos sao cumulativos; o resultado e atraso medio por quadro emitido na janela, desde o primeiro pacote no buffer ate a saida do quadro comprimido. Nao mede fila instantanea do decoder/render. Intervalos sem emissao agora sao marcados como indisponiveis no log, em vez de zero. `jitterBufferTargetDelay` e `jitterBufferMinimumDelay` sao coletados quando Chromium os expoe para separar alvo de playout e minimo imposto pela rede.
- `freezes = delta(inbound-rtp.freezeCount)`, contador do Chromium. Nao e derivado de FPS. Um incremento nao prova sozinho travamento perceptivel quando o conteudo tem poucos quadros; comparar com movimento continuo e `totalFreezesDuration` quando disponivel.
- O perfil Economia antigo era acionado diretamente por jitter RTP >= 80 ms ou buffer >= 120 ms, mesmo com RTT/perda baixos e imagem estatica. Agora jitter/buffer isolados nao classificam `NETWORK`; sob movimento, atraso de playout pode reduzir FPS gradualmente sem baixar resolucao ou bitrate como se fosse falta de banda.
- A mudanca de perfil e registrada apos `setParameters()` aceitar os parametros, incluindo razao, RTT, perda, jitter, playout e contador de mudancas. O modo selecionado pelo usuario e separado do FPS, resolucao e bitrate aplicados. Bitrate se move no maximo 20% por atualizacao e nao e recalculado a cada amostra sem necessidade.
- Captura de tela e video seguem diretamente pelo WebRTC. Nodus controla `maxFramerate`, `maxBitrate` e `scaleResolutionDownBy` do sender; coalesce movimentos de ponteiro; usa canal nao ordenado para ponteiro e confiavel para teclas/cliques; limita o buffer de arquivos a 128 KiB e pausa a transferencia quando o canal de controle excede 8 KiB. Filas internas de captura, encoder, RTP, decoder e renderizacao nao sao expostas/descartaveis pelo Nodus. O relatorio marca essas etapas e a latencia glass-to-glass como `null` quando nao mensuraveis.

Teste real pendente apos a instalacao do novo build em ambos os computadores: (A) 1080p, LAN P2P, 60 s com tela quase estatica; (B) 1080p60, 60 s de movimento continuo (arrastar janelas, rolar, video); (C) 60 s de cliques, digitacao e arraste. Para cada sessao, gerar `node scripts/perf-lab.mjs report <performance.log-host> --duration=60 --peer=<performance.log-viewer>`. Comparar buffer alvo/minimo, freezes, perfil, filas observaveis e fluidez com baseline; nao assumir melhora sem esses logs.

## Riscos

- Captura eficiente no Windows exige API nativa e testes de latencia.
- Controle remoto precisa isolamento forte por permissao.
- Relay pode concentrar custo de banda.
- Acesso nao supervisionado exige armazenamento seguro de credenciais, rate limit e auditoria.
