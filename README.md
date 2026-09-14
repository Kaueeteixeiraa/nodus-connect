# Nodus Connect

Nodus Connect: app desktop Windows com Nodus ID persistente, login Firebase, conexao online via Firestore, visualizacao remota e controle de mouse/teclado com consentimento.

## Stack escolhida

- UI: React + Vite.
- Desktop nativo: Electron com build Windows por electron-builder.
- Coordenacao online: Firebase Auth, Firestore e Hosting.
- Conexao remota: WebRTC/ICE com DataChannel para controle nativo no Windows.

Fontes oficiais consultadas: [Tauri Architecture](https://v2.tauri.app/concept/architecture/), [MDN WebRTC Protocols](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols), [RFC 8827](https://datatracker.ietf.org/doc/html/rfc8827), [RFC 8835](https://datatracker.ietf.org/doc/rfc8835/), [Axum docs](https://docs.rs/axum/latest/axum/).

## Rodar localmente

```bash
pnpm install
pnpm dev:coordination
pnpm dev:desktop
```

- Desktop shell: http://127.0.0.1:5173
- Coordination API: http://127.0.0.1:8787/health

## Firebase

Para usar Firebase no app final, preencha `.env` com as variaveis de `.env.example` e habilite:

- Authentication: Google e Anonymous.
- Firestore: banco de dados em producao.
- Hosting: `apps/desktop/public` para a tela de login Google.

O Nodus usa Firebase para usuarios, configuracoes, historico, presenca, pedidos e sinalizacao da conexao remota.

Publicar regras e login:

```bash
pnpm firebase:login
npx firebase-tools deploy --only firestore:rules,hosting --project seu-projeto
```

## Rodar como app desktop

```bash
pnpm desktop:dev
```

Esse comando abre uma janela nativa do Nodus Connect e habilita menu de bandeja com copia do Nodus ID.

## Gerar EXE Windows

```bash
pnpm desktop:build
```

Saidas:

- `outputs/installer/Nodus-Connect-Setup.exe`: instalador proprio.

## Testar conexao remota MVP

O app faz visualizacao remota e controle com consentimento explicito:

O mesmo aplicativo faz os dois lados: pode solicitar acesso e tambem receber pedidos de acesso.

1. Todos os clientes devem usar o mesmo `Servidor Nodus` em Configuracoes.
2. O computador alvo recebe a solicitacao.
3. O usuario do alvo aceita e seleciona a tela/janela.
4. O solicitante ve a tela remota por WebRTC e pode controlar mouse/teclado dentro da area do video.

Para redes restritivas, publique o pacote gratuito de `infra/turn` e informe o endereco em `Configuracoes > Conexao > Servidor auxiliar`.
Podem ser informados varios enderecos separados por virgula; o aplicativo usa automaticamente o primeiro servidor que responder.

## Validacao

```bash
pnpm test
pnpm build
```

## Estado atual

Implementado:
- Nodus ID persistente no cliente.
- Nodus ID persistente tambem no perfil nativo do app instalado.
- Tela de login antes do painel, com modo local e Google OAuth configuravel.
- Onboarding curto com nome do dispositivo.
- Registro/heartbeat no Firebase com fallback no relay online.
- Busca de dispositivo por Nodus ID.
- Recentes, favoritos, historico de acessos, renomear clientes e pastas.
- Visualizacao remota por WebRTC com aceite explicito.
- Controle nativo de mouse/teclado no Windows durante sessao aceita.
- Transferencia de arquivos durante a sessao aceita.
- Reconexao ICE real e qualidade adaptativa por latencia/perda.
- Selecao de monitor, audio remoto, clipboard e gravacao WebM.
- Permissoes por pedido e acesso automatico apenas para computadores confiaveis.
- Wake-on-LAN, diagnostico, marcadores, notas e multiplas sessoes.
- Firestore para eventos em tempo real, com WebSocket como fallback.
- STUN/TURN com credenciais temporarias e coturn pronto para Docker.
- Contrato inicial de protocolo e permissoes.

Pendente:
- Publicar o servidor `infra/turn` em uma maquina com IP publico.
- Assinar digitalmente o instalador com certificado de codigo.
