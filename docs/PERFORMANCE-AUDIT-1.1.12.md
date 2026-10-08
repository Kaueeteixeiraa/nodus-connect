# Auditoria de desempenho - Nodus Connect 1.1.12

Branch: `main`. Commit inicial: `1535566c8b272dbb313f8570ad8240d7196110a1`.
Build candidata, ainda nao publicada. NAO VALIDADO EM AMBIENTE REAL nos dois PCs.

## Correcoes implementadas

- Probe nativo assincrono, com uma chamada compartilhada e cache de capacidades. Falha permite nova tentativa apos 30 s; nenhuma escolha de captura foi removida.
- GPU memoizada e invalidada por atualizacao do Electron. Interface aparece antes de enumeracao/probes secundarios.
- Teste completo de ICE apenas no diagnostico habilitado; descoberta de servidores continua em background. TURN permanece disponivel.
- Reserva online usa uma operacao existente no servidor em vez de check + policy + reserve. Enrollment inicial continua necessario; backend preserva revogacao, permissoes e limite de 200 acessos do iniciador.
- Pedido reutiliza lookup valido do mesmo ID, online, com owner e atualizado; caso contrario refaz lookup. Regras/backend continuam sendo autoridade.
- Fetch ICE compartilha requests simultaneos. TURN com expiracao desconhecida nunca entra no cache; credenciais declaradas expiram com margem de seguranca.
- Relay compartilha autorizacao de candidatos concorrentes apenas quando elegivel ao cache ja existente. Erros nunca sao cacheados; TTLs de seguranca nao foram aumentados.
- Aceite termina antes da captura Chromium; peer nasce antes da captura. Listener Chromium continua aguardando tracks para evitar answer sem video. Paralelismo total de midia/negociacao NAO implementado nesta etapa.
- Licenca e QuickSupport carregam por import dinamico; imagens de marca sairam do JavaScript inline, sem alterar resolucao/qualidade. Lista de presenca acompanha apenas dispositivos visiveis, sem remover listener dos pedidos ou do proprio dispositivo.
- Setup inicial extrai somente runtime Electron + interface/bootstrap. Aplicativo/nativos/GStreamer sao extraidos diretamente para staging apos confirmacao; metadados de tamanho/contagem/SHA256 sao calculados no build. Rollback, cancelamento e atualizacao existentes foram preservados.
- IPC tardio verifica janela e sender destruidos antes de acessar webContents.

## Preservado

Nenhum binario nativo, DLL de captura/input, GStreamer, TURN, regra de seguranca ou limite comercial foi removido. Mouse unordered/maxRetransmits=0, coalescing, teclado, clipboard, audio e arquivos mantiveram os contratos existentes. QuickSupport segue completo/offline, sem baixar runtime na primeira abertura. Nenhuma dependencia nova.

## Medicoes

| Metrica | Antes | Depois | Escopo |
| --- | ---: | ---: | --- |
| Payload Setup/aplicativo instalado | 361.99 MiB | 361.74 MiB | Payload final, antes da renomeacao do exe instalado |
| Payload QuickSupport | 338.80 MiB | 338.72 MiB | Diretorio completo, nao apenas ASAR |
| Setup unico | 122.45 MiB | 166.76 MiB | Zlib aumenta 36.2%, priorizando abertura; SHA-256 `a799efc9...b06559` |
| QuickSupport unico | 87.62 MiB | 87.07 MiB | Template completo e offline; SHA-256 `3e35132f...b73327` |
| Entrada JS desktop | PENDENTE inventario anterior | 495.61 kB | Build Vite, bytes sem gzip |
| Desktop processo -> janela / ready / utilizavel | 171 / 566 / 634 ms | 210 / inconclusivo / 707 ms | Antes: uma amostra; depois: mediana de 3 unpacked/offline. Sem ganho demonstrado |
| Instalador processo -> janela / ready / utilizavel | 162 / 558 / 898 ms | 218 / 643 / 676 ms | Depois: mediana de 3 unpacked/offline; utilizavel 24.7% menor |
| Container Setup -> janela / utilizavel | 48.363 s / nao instrumentado | 8.844 / 8.483 s | Mediana de 3, real container/local/no-install; primeira amostra 12.445 / 11.383 s |
| QuickSupport portatil -> janela | 27.089 s | 20.767 s | Mediana de 3 no mesmo PC; reducao de 23.3% |
| QuickSupport portatil -> utilizavel | nao instrumentado | 19.858 s | Duas amostras validas; log interno marcou UI pronta em ~2.07 s apos iniciar Electron |
| Conectar -> lookup / licenca / pedido | NAO VALIDADO EM AMBIENTE REAL | NAO VALIDADO EM AMBIENTE REAL | Logs novos registram fases monotonicamente por sessao/papel |
| Aceitar -> peer / ICE -> primeiro frame | NAO VALIDADO EM AMBIENTE REAL | NAO VALIDADO EM AMBIENTE REAL | Frame registrado em requestVideoFrameCallback, nao em srcObject |
| Mouse -> aplicacao host | NAO VALIDADO EM AMBIENTE REAL | NAO VALIDADO EM AMBIENTE REAL | Diagnostico de input existente mede evento/canal/IPC/barreira nativa |

Nao se subtraem timestamps de PCs diferentes sem sincronizacao. `perf-lab.mjs timings` devolve null para entrega one-way entre PCs; `report` conserva RTT e etapas locais do input. A reducao de chamadas de rede e comprovada por testes; ganho em milissegundos depende da rede e ainda nao foi medido.

### Compressao

Benchmark local do payload QuickSupport 1.1.11:

| Formato | Bytes | Mediana de extracao | Observacao |
| --- | ---: | ---: | --- |
| 7z maximum | 91483182 | 9605 ms | Tres execucoes: 9609, 9550, 9605 |
| ZIP normal | 142161943 | 7052 ms | Tres execucoes: 6923, 7052, 8129; +55.4% de tamanho |
| 7z normal | 91483182 | 19248 ms | Tres execucoes: 14387, 20001, 19248; com contencao, sem comparacao valida de tempo |

Inspecao do electron-builder instalado confirma que tanto normal quanto maximum usam `-mx=9` em 7z. Trocar somente o nome da configuracao nao resolve. ZIP nao foi adotado: aumentaria muito o arquivo completo; a medicao de extracao nao equivale a abertura real em PC lento. Arquivos/bytes extraidos foram conferidos, sem inferir desempenho de rede. Bootstrap ainda depende do runtime Electron: nao e um instalador nativo minusculo.

7z nivel 3 foi medido no QuickSupport final: 113404185 bytes e mediana de extracao de 6864 ms (7298, 6767, 6864), contra 91483182 bytes e 9605 ms no nivel 9 anterior. O nivel 3 nao foi adotado porque aumentaria o portatil em cerca de 24%, anulando a reducao de tamanho obtida nesta versao; a candidata final ficou com 91299803 bytes.

O Setup foi alterado de LZMA para zlib depois de medir o container real: a mediana da interface utilizavel caiu para 8.483 s, mas o artefato aumentou 44.31 MiB. A extracao zlib terminou em 9.05 s e produziu os mesmos 261 arquivos, 379311652 bytes e SHA-256 do `app.asar`; servico nativo e GStreamer foram conferidos.

## Sinalizacao persistente: pendencia arquitetural

A producao usa Firestore para pedidos e sinalizacao. O relay WebSocket existente mantem clientes/presenca/sinais em memoria de uma instancia; simplesmente selecionar esse canal na Vercel pode perder mensagens entre instancias, reconexoes e autorizações. A Vercel oferece WebSockets, mas exige coordenacao de estado/publicacao entre instancias e reconexao. O usuario confirmou que nao possui servidor persistente nem Redis. Nao houve contratacao nem migracao de alto risco. Firestore continua principal nesta build; fases 6/7 da migracao WebSocket estao pendentes de infraestrutura/validacao. Fonte: https://vercel.com/docs/functions/websockets

## Testes

- Baseline: 383 aprovados; 6 pulados por emulador Firestore indisponivel.
- Final: 403 aprovados; 0 falhas; mesmos 6 pulados.
- TypeScript + Vite: aprovados. Avisos de chunks Firebase/Standby maiores que 500 kB preservados e documentados, sem refatoracao arriscada.
- Browser: 9 layouts QuickSupport/gerador (320/520/1366), imagens renderizadas, encerramento/renomeacao/persistencia e ASAR real sem requests de assets excluidos; sem erros ou overflow horizontal.
- QuickSupport assinado de teste criado ao reaproveitar um token valido existente, sem chave privada ou publicacao. Abertura real medida e perfil relido/validado com a chave publica embarcada.
- Criticos: reserva unica/fail-closed, lookup fresco e fallback, probe compartilhado/timeout, ICE cache com expiracao, autorizacao concorrente, cancelamento/erro/extracao incompleta/SHA256, IPC destruido e parser NSIS Unicode/espacos.
- Setup real: interface medida em tres execucoes; extracao isolada, contagem, bytes, `app.asar`, servico e GStreamer aprovados. Nenhuma instalacao foi executada.
- Regras Firestore em emulador, ciclo completo de atualizacao e sessao em dois PCs: NAO VALIDADO EM AMBIENTE REAL.

## Validacao fisica obrigatoria

Comparar primeiro 1.1.11 e depois esta candidata nos mesmos dois PCs, mesma rede, sem compilacao concorrente. Fechar a versao antiga antes de abrir o diagnostico. Testar tres aberturas de desktop/Setup/QuickSupport, LAN e Internet, normal -> normal e normal -> QuickSupport, autorizacao por senha e aceite, direto e TURN, mouse em movimento e parado/alternancia dos cursores, `teste teste`/Ctrl+C/V/Shift, clipboard, arquivos, audio, desconexao, reconexao, ICE restart, contador/licenca 200 e bloqueio do iniciador sem bloquear recebimento. Verificar cancelamento de extracao, rollback e atualizacao automática com manifest confiavel. Enviar desktop.log/performance.log dos dois lados.

A candidata nao substitui a versao publica nem o template da API antes dessa validacao.

## Arquivos alterados

Electron main/preload/tipos; App/QuickSupport/Standby3D; core api/firebase/licensing/storage; instalador main/preload/HTML; package.json; configuracao QuickSupport; wrapper/make-installer; relay/license-gate; testes native-media/remote-controls/installer/quick-support/startup-connection/perf-lab; laboratorios startup/package-audit e este relatorio.

## 30 maiores arquivos - Setup e aplicativo instalado

| Item | MiB | Classificacao |
| --- | ---: | --- |
| `Nodus Connect Setup.exe` | 215.02 | Electron runtime; required until proven otherwise |
| `resources/app.asar` | 26.26 | application; candidate for lazy modules and external assets |
| `dxcompiler.dll` | 24.43 | Electron runtime; required until proven otherwise |
| `LICENSES.chromium.html` | 19.37 | redistribution license; required |
| `icudtl.dat` | 10.37 | Electron runtime; required until proven otherwise |
| `libGLESv2.dll` | 7.66 | Electron runtime; required until proven otherwise |
| `resources.pak` | 6.90 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/libcrypto-3-x64.dll` | 6.77 | WGC-only; retain for native video/audio and fallback |
| `vk_swiftshader.dll` | 5.25 | Electron runtime; required until proven otherwise |
| `d3dcompiler_47.dll` | 4.52 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstrsrtp.dll` | 3.29 | WGC-only; retain for native video/audio and fallback |
| `ffmpeg.dll` | 2.93 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/gstd3dshader-1.0-0.dll` | 2.50 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/gio-2.0-0.dll` | 1.75 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstd3d11.dll` | 1.65 | WGC-only; retain for native video/audio and fallback |
| `dxil.dll` | 1.44 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/glib-2.0-0.dll` | 1.37 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/gstreamer-1.0-0.dll` | 1.31 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/libssl-3-x64.dll` | 1.24 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstmediafoundation.dll` | 1.15 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/gstcodecparsers-1.0-0.dll` | 0.92 | WGC-only; retain for native video/audio and fallback |
| `vulkan-1.dll` | 0.89 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/gstvideo-1.0-0.dll` | 0.84 | WGC-only; retain for native video/audio and fallback |
| `v8_context_snapshot.bin` | 0.71 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/gstwinrt-1.0-0.dll` | 0.67 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstrtp.dll` | 0.66 | WGC-only; retain for native video/audio and fallback |
| `locales/pt-PT.pak` | 0.65 | Electron runtime; required until proven otherwise |
| `locales/pt-BR.pak` | 0.64 | Electron runtime; required until proven otherwise |
| `locales/en-US.pak` | 0.54 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstrtpmanager.dll` | 0.53 | WGC-only; retain for native video/audio and fallback |

## 30 maiores diretorios - Setup e aplicativo instalado

Os totais de diretorios se sobrepoem (pais e filhos); nao devem ser somados. O Setup .exe e um container do mesmo payload, acrescido de bootstrap. Runtime de bootstrap nao e instalado no lugar do aplicativo completo.

| Item | MiB | Classificacao |
| --- | ---: | --- |
| `resources` | 59.32 | Electron runtime; required until proven otherwise |
| `resources/native` | 33.07 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer` | 32.44 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin` | 22.21 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib` | 8.82 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0` | 8.82 | WGC-only; retain for native video/audio and fallback |
| `locales` | 1.83 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/share` | 1.40 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/share/licenses` | 1.40 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libiconv` | 0.06 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/cairo` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/pycairo` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libnice` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/taglib` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/mingw-runtime` | 0.04 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/gobject-introspection` | 0.04 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/librsvg` | 0.04 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libiconv/bins` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/librtmp` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/lame` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/gst-plugins-bad-1.0` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/dump-versions` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/ffmpeg` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/fribidi` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/gst-shell` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/json-glib` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/ladspa` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libdv` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/mpg123` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/sbc` | 0.03 | redistribution license; required |
## 30 maiores arquivos - QuickSupport

| Item | MiB | Classificacao |
| --- | ---: | --- |
| `Nodus Connect.exe` | 215.02 | Electron runtime; required until proven otherwise |
| `dxcompiler.dll` | 24.43 | Electron runtime; required until proven otherwise |
| `LICENSES.chromium.html` | 19.37 | redistribution license; required |
| `icudtl.dat` | 10.37 | Electron runtime; required until proven otherwise |
| `libGLESv2.dll` | 7.66 | Electron runtime; required until proven otherwise |
| `resources.pak` | 6.90 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/libcrypto-3-x64.dll` | 6.77 | WGC-only; retain for native video/audio and fallback |
| `vk_swiftshader.dll` | 5.25 | Electron runtime; required until proven otherwise |
| `d3dcompiler_47.dll` | 4.52 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstrsrtp.dll` | 3.29 | WGC-only; retain for native video/audio and fallback |
| `resources/app.asar` | 3.13 | application; candidate for lazy modules and external assets |
| `ffmpeg.dll` | 2.93 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/gstd3dshader-1.0-0.dll` | 2.50 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/gio-2.0-0.dll` | 1.75 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstd3d11.dll` | 1.65 | WGC-only; retain for native video/audio and fallback |
| `dxil.dll` | 1.44 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/glib-2.0-0.dll` | 1.37 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/gstreamer-1.0-0.dll` | 1.31 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/libssl-3-x64.dll` | 1.24 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstmediafoundation.dll` | 1.15 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin/gstcodecparsers-1.0-0.dll` | 0.92 | WGC-only; retain for native video/audio and fallback |
| `vulkan-1.dll` | 0.89 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/gstvideo-1.0-0.dll` | 0.84 | WGC-only; retain for native video/audio and fallback |
| `v8_context_snapshot.bin` | 0.71 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/bin/gstwinrt-1.0-0.dll` | 0.67 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstrtp.dll` | 0.66 | WGC-only; retain for native video/audio and fallback |
| `locales/pt-PT.pak` | 0.65 | Electron runtime; required until proven otherwise |
| `locales/pt-BR.pak` | 0.64 | Electron runtime; required until proven otherwise |
| `locales/en-US.pak` | 0.54 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/lib/gstreamer-1.0/gstrtpmanager.dll` | 0.53 | WGC-only; retain for native video/audio and fallback |

## 30 maiores diretorios - QuickSupport

| Item | MiB | Classificacao |
| --- | ---: | --- |
| `resources` | 36.30 | Electron runtime; required until proven otherwise |
| `resources/native` | 33.07 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer` | 32.44 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/bin` | 22.21 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib` | 8.82 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/lib/gstreamer-1.0` | 8.82 | WGC-only; retain for native video/audio and fallback |
| `locales` | 1.83 | Electron runtime; required until proven otherwise |
| `resources/native/gstreamer/share` | 1.40 | WGC-only; retain for native video/audio and fallback |
| `resources/native/gstreamer/share/licenses` | 1.40 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libiconv` | 0.06 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/cairo` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/pycairo` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libnice` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/taglib` | 0.05 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/mingw-runtime` | 0.04 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/gobject-introspection` | 0.04 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/librsvg` | 0.04 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libiconv/bins` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/librtmp` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/lame` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/gst-plugins-bad-1.0` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/dump-versions` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/ffmpeg` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/fribidi` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/gst-shell` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/json-glib` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/ladspa` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/libdv` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/mpg123` | 0.03 | redistribution license; required |
| `resources/native/gstreamer/share/licenses/sbc` | 0.03 | redistribution license; required |
