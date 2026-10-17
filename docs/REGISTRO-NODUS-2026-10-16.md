# Nodus Connect - Registro de estado

Data: 16/10/2026. Fuso: America/Sao_Paulo.
Escopo: codigo local, artefatos, release no GitHub e paginas publicas consultadas.
Nao inclui credenciais, tokens, identificadores de hardware ou dados de usuarios.

## Versao e repositorio

| Item | Estado verificado |
| --- | --- |
| Produto | Nodus Connect, acesso remoto para Windows 10 ou superior, x64 |
| Versao do projeto e release | 1.1.27 / v1.1.27 |
| Branch atual | main |
| Commit local e main remota | c8129cad09e0025a4aa437299e6437ff204ca7ce |
| Ultimo commit | Publicacao da 1.1.27 com clipboard de arquivos bidirecional |
| Release | Publicada em 14/10/2026, sem marcacao de rascunho ou pre-release |
| Backup mais recente identificado | backup/definitivo-1.1.25-20261014, commit 8dbf7ee47569ae66539b9239201b0a05c7df7f26 |

O backup identificado nao acompanha o commit atual da main. Antes deste registro,
havia alteracoes locais nao commitadas em tres scripts de empacotamento/testes
e no relatorio de desempenho. Elas nao estao na main remota.

Repositorio: https://github.com/Kaueeteixeiraa/nodus-connect
Release: https://github.com/Kaueeteixeiraa/nodus-connect/releases/tag/v1.1.27

## Recursos presentes

- Acesso por Nodus ID, pedido de autorizacao, permissoes por sessao e senha de acesso.
- Controle de mouse e teclado, clipboard de texto, audio e transferencia de arquivos.
- Ctrl+C/Ctrl+V de arquivos nos dois sentidos, implementado na 1.1.27.
- Multiplas sessoes/janelas, selecao de monitor e ajustes de qualidade/resolucao.
- Dispositivos recentes, favoritos, pesquisa e renomeacao.
- Senhas de conexao protegidas pelo armazenamento seguro do sistema operacional.
- Diagnosticos opcionais de conexao, rota, FPS e resolucao; logs de desktop/desempenho.
- Temas visuais, incluindo Japao Feudal e Japao Feudal Escuro.
- Atualizacao manual e distribuicao administrada para verificacao ao abrir o aplicativo.

Presenca de um recurso no codigo nao significa nova homologacao em dois PCs.
As mudancas recentes de compactacao nao alteraram os arquivos do aplicativo.

## QuickSupport

- Cliente portatil completo, sem download inicial de runtime.
- Personalizacao de empresa, mensagem, logotipo, senha e permissoes.
- Renomeacao do computador atendido pela interface.
- Senha de 3 a 128 caracteres na validacao atual.
- Se "Solicitar confirmacao do cliente" estiver marcado, o aceite continua obrigatorio.
- Sem essa confirmacao, a senha valida pode autorizar a entrada conforme o perfil.
- Perfis assinados e verificacao com a chave publica embarcada.
- Template publicado deve acompanhar a versao do aplicativo e a configuracao da API.

## Uso pessoal e empresa

Valores abaixo sao padroes do codigo, nao uma leitura das politicas ativas do servidor:

- Uso pessoal: limite interno padrao de 10.000 acessos iniciados.
- A contabilizacao ocorre no estabelecimento da sessao, uma vez por sessao; receber acesso nao consome essa franquia.
- Sessao pessoal: ate 10 minutos, com possibilidade de reconectar depois do encerramento.
- Mensagem: "Limite de tempo do usuario pessoal excedido. Reconecte para continuar."
- Interface apresenta "Controle da empresa", sem mostrar o contador do perfil pessoal.
- Empresa: vinculacao por token, sem limite de tempo por sessao.
- Dispositivos e sessoes simultaneas sao configuraveis por empresa; padroes tecnicos: 20 dispositivos e 5 sessoes simultaneas.
- Identidade por computador, revisao de casos ambiguos, bloqueios e autorizacao no servidor estao implementados.
- Ativacao efetiva do controle por hardware e demais flags de producao nao foi consultada nesta coleta.

O site apresenta o programa gratuito e apoio voluntario por Pix. Isso nao confirma
precos ou condicoes particulares de contratos empresariais.

## Admin e arquitetura

Admin: visao geral, solicitacoes, dispositivos, empresas e atualizacoes; pesquisas,
filtros, bloqueio/desbloqueio, exclusao de empresas canceladas e trilhas de auditoria.
A distribuicao de atualizacoes pode ser liberada ou pausada pelo painel.
Nenhuma politica de distribuicao foi alterada para este registro.

Desktop: Electron/Chromium, React, TypeScript e Vite. Versoes instaladas verificadas:
Electron 43.3.0, React 19.2.8, TypeScript 5.9.3 e Vite 7.3.6.
Essas versoes locais nao substituem o manifesto do binario publicado.

Transporte: WebRTC, conexao direta quando possivel e fallback TURN; Firebase Auth/
Firestore e servicos de coordenacao/autorizacao. Captura Chromium e backend nativo
WGC/GStreamer conforme configuracao/capacidade. Arquivos usam ECDH/AES-GCM.
Nao houve migracao para servidor proprio ou contratacao nesta etapa.
Continuar priorizando sinalizacao por eventos e eliminacao de leituras duplicadas;
nao assumir disponibilidade ilimitada no plano gratuito.

## Artefatos e distribuicao

MB = 1.000.000 bytes. Tamanho de arquivo compactado nao equivale a tamanho instalado.

| Artefato | Bytes | MB | Situacao |
| --- | ---: | ---: | --- |
| Nodus-Connect-Setup-1.1.27.exe | 180016433 | 180,02 | Setup publicado; download atual do site |
| Nodus-QuickSupport-1.1.27.exe | 91315509 | 91,32 | Template publicado no GitHub |
| Nodus-Connect-Setup-1.1.27-Compact.exe | 136817851 | 136,82 | Setup alternativo local; nao publicado |
| nodus-completo-zpaq5.zpaq | 111796011 | 111,80 | Arquivo de dados experimental; NAO e setup executavel |

O tamanho experimental de 111,8 MB foi aceito pelo usuario. Ainda falta montar e
validar um instalador correspondente; decoder e involucro adicionarao tamanho.
O pacote experimental nao foi publicado e nao substituiu o setup de 180,02 MB.
Payload de origem: 261 arquivos, 384649868 bytes; nenhum recurso foi retirado.

SHA-256 dos principais arquivos:

- Setup publicado: `67fa2def7029b4a79fab2ea8114aa9b9ebd1d40d9cbc0eb97d6641503daadce4`.
- QuickSupport publicado: `7d2688625a774c8a3dde3c44645fb3dc01d128237571049068e7a3b507d8f46d`.
- Setup Compact local: `5b8d7f306cbaef9d4adfcc6ea4bfb36a328c69f3ee3c2eaeb334f7eafdb6da12`.
- ZPAQ experimental: `f2ee23a26de1150062965aa990ac73922218baf5829103c4255483f24c3a1fbb`.

Enderecos utilizados:

- Download: https://nodus-connect-download.vercel.app/ (HTTP 200, aponta para 1.1.27).
- Apoio/Pix: https://nodus-connect-download.vercel.app/licen%C3%A7a (HTTP 200).
- Admin: https://nodus-connect-admin.vercel.app/ (fluxo autenticado nao retestado).
- API: https://nodus-connect-license.vercel.app/ (politicas de producao nao consultadas).

## Validacoes e pendencias

Ultima validacao de codigo nesta conversa: 583 testes aprovados; 13 ignorados
por ausencia do emulador Firestore. TypeScript/Vite e verificacao de integridade
do empacotamento aprovados. Avisos existentes de chunks grandes foram mantidos.

As extracoes 7z e Compact tiveram seus arquivos comparados ao payload. O arquivo
ZPAQ completo nao passou por extracao/instalacao ponta a ponta nesta etapa.
O manifesto do setup publicado ainda registra `realTwoPcValidation: PENDING`;
relatos anteriores de uso nao substituem essa homologacao formal.

Pendencias: montar/testar o novo setup, validar atualizacao/rollback e QuickSupport
nos dois PCs e, somente apos autorizacao, publicar artefatos, main e backup atualizados.
Nada foi instalado, publicado ou liberado automaticamente durante este registro.

## Revisao posterior: candidata 1.1.28

O registro acima descreve a release 1.1.27. As melhorias abaixo estao na copia local da `main`, sem commit, publicacao nem distribuicao automatica:

- Instalador completo sem perdas com subpacote 7z solido, mantendo imagens, runtime e recursos. ZPAQ 111,8 MB foi descartado para distribuicao: extracao local de 1764 segundos. O usuario aprovou cerca de 114 MB e instalacao mais rapida.
- Todos os arquivos extraidos conferidos por SHA-256, quantidade e tamanho. Verificador de release alinha setup, QuickSupport, checksums, manifesto e fontes.
- Matriz de 20 verificacoes fisicas vinculada ao hash exato do setup; uma matriz incompleta impede promocao pelo verificador.
- Assinatura Authenticode integrada apos finalizar o executavel. Falta certificado: nao anunciar os arquivos como assinados.
- Percentis limitados de RTT, codificacao, decodificacao, fila e apresentacao; deteccao de falta de progresso sem tratar desktop parado como congelado.
- Recuperacao ICE descarta trabalho obsoleto; queda libera teclas/botoes mantidos pressionados, preservando outras sessoes.
- Consultas simultaneas compartilham leitura e reutilizam presenca ja recebida. Contadores locais registram listeners ativos e categorias de erro, sem mensagens privadas.
- Admin usa resumos curtos e agregacao online. Inventario de versao/estado/sessoes e pilotos aproveitam presenca existente. Monitor nao carrega licencas/hardware e para com distribuicao pausada ou pagina oculta.
- Relatorio de suporte sanitizado no Nodus e QuickSupport, salvo localmente, sem upload automatico.

Procedimentos e limites: `docs/DEVELOPMENT.md`, secao Candidata 1.1.28. Homologacao fisica e assinatura valida continuam pendentes. A producao 1.1.27 permanece inalterada.

Resultado local final:

- Setup: 114.906.181 bytes; SHA-256 `840fa67a1229cb8bca54a5d75857be88dbe17347acff5643eae8b0c1e09104fc`.
- Template QuickSupport: 91.319.433 bytes; SHA-256 `2681f7938b84f1830002f616eecdd0cc444478e7ad3cf274576c0a96208c83a8`.
- Extracao do setup: 18,699 segundos nesta maquina; 261 arquivos e 384.661.814 bytes conferidos integralmente por SHA-256. Nao representa o tempo completo de instalacao.
- Suite final: 611 testes aprovados, nenhum reprovado; os 13 testes dependentes de Firestore foram aprovados separadamente no emulador local. A paginacao foi retestada apos o ultimo ajuste.
- Builds Desktop/instalador/QuickSupport, Admin e API aprovados. Fluxo Admin simulado no navegador em 1366, 768 e 320 px, sem requisicoes reais a producao.
- Instalacao/atualizacao/rollback e wrapper compacto testados em pastas isoladas. Matriz fisica de 20 casos permanece PENDING: NAO VALIDADO EM AMBIENTE REAL.
- Artefatos sem assinatura (NotSigned), sem certificado contratado. Nenhum commit, push, deploy ou rollout realizado.
