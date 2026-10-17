# Desenvolvimento Local

## Requisitos atuais

- Node.js 24+
- pnpm 11+

## Comandos

```bash
pnpm install
pnpm dev:coordination
pnpm dev:desktop
pnpm test
pnpm build
```

## Simular dois clientes

1. Abra o desktop shell em uma janela normal.
2. Abra outro perfil/navegador ou limpe o storage para gerar outro Nodus ID.
3. Rode o Coordination Server.
4. Use o ID de um cliente no outro para testar lookup.

Na etapa Tauri, cada instalacao tera storage nativo separado.

## Recuperacao 0.4.25

`0.4.25-recovery.1` e uma build de validacao, nao uma release estavel.
O padrao e Chromium, com o comportamento funcional de conexao da 0.4.25.
Captura legada nao garante supressao do cursor do host e pode mostrar duas setas.
O codigo anterior esta preservado na branch `archive/pre-recovery-0.4.26`.

Encerre o Nodus pela bandeja antes de trocar backend: uma segunda instancia nao altera o ambiente da primeira.
Primeiro valide Chromium nos dois PCs (conexao, video, mouse e teclado). Nao avance se falhar.

```powershell
$env:NODUS_CAPTURE_BACKEND = 'chromium'
$env:NODUS_CAPTURE_FALLBACK = '1'
& "$env:LOCALAPPDATA\Programs\Nodus Connect\Nodus Connect.exe"
```

Somente depois da baseline aprovada, teste WGC explicitamente no host:

```powershell
$env:NODUS_CAPTURE_BACKEND = 'wgc'
$env:NODUS_CAPTURE_FALLBACK = '1'
& "$env:LOCALAPPDATA\Programs\Nodus Connect\Nodus Connect.exe"
```

`NODUS_CAPTURE_FALLBACK=0` proibe o fallback naquele teste experimental; nunca e o padrao.
Falha WGC registra estagio, parametros, erro nativo, debug do GStreamer, stderr e codigo de saida.
HRESULT/Windows error permanecem UNAVAILABLE quando o plugin nao fornece esses codigos; nao sao inferidos.
`STREAM_READY` exige primeiro frame capturado, primeiro frame codificado e primeiro pacote RTP produzido.
Isso nao comprova recebimento por outro PC. O timeout de startup e 8 segundos sem progresso, com limite total de 30 segundos, separado dos 5 segundos de discovery.

Build e testes automatizados autorizam testar, nao promover a estavel.
Antes de publicar: build, testes, compilacao nativa, conexao em dois PCs, video e input aprovados.
Cursor corrigido exige observacao de exatamente uma seta com os dois usuarios movendo seus mouses.
Nao ativar WGC automaticamente antes desses criterios. ICE, codecs, qualidade, bitrate e audio permanecem fora desta recuperacao.

## Candidata 1.1.28

- `pnpm test`: regressao local, incluindo recuperacao, privacidade e rollback de arquivos isolado.
- `pnpm test:rules`: exige Java 21 no PATH; utiliza somente `demo-nodus-licensing`, sem acessar o projeto real.
- `pnpm build:admin` e `pnpm build:licensing`: validam as duas aplicacoes de administracao.
- `pnpm installer:build`: gera setup compacto completo e QuickSupport da mesma versao.
- `pnpm release:check`: extrai o setup, compara todos os hashes e cria a matriz em `work/release-validation-<versao>.json`. Nao aprova testes fisicos automaticamente.
- `node scripts/verify-release.mjs --extract --release`: exige matriz preenchida e vinculada ao hash exato do setup; nao publica arquivos.
- `--require-signature`: exige assinaturas Authenticode validas no setup e QuickSupport; sem certificado, registra `NotSigned`.

O hook `afterSign` e o empacotador aceitam `NODUS_SIGN_CERT_SHA1`, `NODUS_SIGNTOOL` (caminho absoluto) e `NODUS_SIGN_TIMESTAMP_URL` (HTTPS). A chave privada permanece no armazenamento de certificados do Windows. `NODUS_REQUIRE_SIGNATURE=1` impede builds sem certificado. Referencia: [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).

Antes de distribuir: aplicar os indices de `services/licensing/firestore.indexes.json`, publicar os dois executaveis, checksums e manifesto, e alinhar o template da API com hash/versao do QuickSupport. A API recusa liberar novas versoes incompletas. O primeiro rollout para clientes anteriores a 1.1.28 precisa ser global ou manual; esses clientes nao reconhecem pilotos. Pausas podem levar ate dois minutos para propagar pelos caches existentes.

O Admin mostra dados reportados pelo cliente, nao comprovantes de instalacao. O monitor atualiza apenas a pagina visivel, a cada minuto, enquanto a distribuicao estiver ativa. Clientes antigos aparecem sem versao informada. Versao/estados aproveitam a presenca existente, sem novos heartbeats. O modo `runtimeOnly` evita consultas de licencas/hardware neste monitor.

`scripts/admin-smoke.cjs` testa o Admin local com API/autenticacao simuladas somente no navegador; nenhuma alteracao real e enviada. Aceita `NODUS_PLAYWRIGHT`, `NODUS_CHROMIUM` e `NODUS_ADMIN_TEST_URL`. Capturas ficam em `work/admin-validation`.

O relatorio de suporte e salvo localmente pelo usuario no Nodus ou QuickSupport. Inclui apenas numeros e estados permitidos; exclui nomes, IDs, IPs, caminhos, senhas, tokens e conteudo copiado. Percentis sao das medias de intervalos de estatisticas, nao latencia de input nem medicoes por quadro. Consumo de Firestore e estimativa local, sem leituras de regras nem operacoes da API.

Conexao em dois PCs, desempenho WAN/TURN e instalacao real: NAO VALIDADO EM AMBIENTE REAL nesta revisao. A matriz permanece pendente; testes de arquivos isolados nao alteram registro, atalhos, servicos nem a instalacao existente.

### Economia Firestore posterior ao setup

Auditoria e cenarios: `docs/FIRESTORE-COST-AUDIT-2026-10-17.md`. As mudancas posteriores nao estao no setup 1.1.28 ja gerado. O modo empresarial por eventos exige regras e API novas, cliente iniciador solicitando a capacidade e receptor anunciando `license-events-v1`. `LICENSE_BUSINESS_EVENTS_READY` deve continuar ausente/falso ate a homologacao fisica; QuickSupport, offline e clientes antigos mantem heartbeat. Nao ativar a flag antes de publicar/testar as regras de grants e controles. Bloqueio e mudanca de responsavel sao eventos diretos do servidor, nao inferencias de dependencias de regras. Os controles get-only nao contem tokens nem provas de hardware e negam listagem/escrita pelo cliente.
