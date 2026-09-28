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
