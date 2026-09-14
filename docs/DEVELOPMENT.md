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
