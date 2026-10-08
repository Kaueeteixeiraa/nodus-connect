# Deploy

Ainda nao ha deploy de producao.

Plano:

- Empacotar cliente Windows via Tauri.
- Assinar binarios e instalador.
- Publicar Coordination/Auth/Relay em infraestrutura separada.
- TLS obrigatorio em APIs.
- TURN/relay com credenciais efemeras.
- Atualizacao automatica somente com verificacao de assinatura e integridade.

## Release Windows

- `pnpm installer:build` gera setup e QuickSupport da mesma versao e valida seus binarios, chave publica e hashes.
- Enviar ambos os executaveis e seus arquivos `.sha256` ao mesmo release do GitHub.
- Atualizar `NODUS_SUPPORT_TEMPLATE_VERSION` e `NODUS_SUPPORT_TEMPLATE_SHA256` na API de licencas e aplicar em um novo deployment.
- Conferir a geracao do QuickSupport antes de marcar o release como latest e atualizar o site. Nunca publicar somente o setup.

## Distribuicao pelo Admin

- A partir da versao 1.1.16, o Nodus instalado consulta a autorizacao assinada ao abrir. Versoes anteriores precisam receber essa versao uma vez via atualizador existente ou setup.
- Em Atualizacoes, informar uma versao estavel publicada no GitHub e liberar para todos. Apenas administradores autenticados recentemente podem liberar ou pausar; cada alteracao gera auditoria.
- A consulta publica tem cache de 60 segundos no CDN e por instancia, sem autenticacao Firebase, gravacoes ou polling. A pausa pode levar ate 60 segundos para aparecer.
- O cliente valida assinatura, validade, origem, tamanho e SHA-256; revalida a liberacao depois do download. Sessoes ativas adiam a instalacao para outra abertura. Falhas preservam o aplicativo; tentativas de instalacao automatica da mesma versao tem intervalo de uma hora para evitar ciclos de rollback.
- QuickSupport portatil nao e substituido automaticamente; gerar um novo pacote preservando o perfil assinado do cliente.
