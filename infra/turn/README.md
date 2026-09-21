# Servidor auxiliar Nodus

Requer uma maquina Linux com IP publico e Docker. Copie `.env.example` para `.env`, preencha dominio, IP e uma chave longa, libere TCP/UDP 3478, TCP/UDP 443 e UDP 49152-65535, depois execute:

```bash
docker compose --env-file .env -f compose.yml up -d --build
```

Se a instalacao usar o binario legado, o comando equivalente e `docker-compose --env-file .env -f compose.yml up -d --build`.

No Nodus, informe `http://SEU_DOMINIO:8787` em **Configuracoes > Conexao > Servidor auxiliar** ou compile com `VITE_NODUS_API=https://SEU_DOMINIO` quando existir um proxy HTTPS para a API. O Coturn usa rede direta do host para evitar NAT e copias extras do Docker. A porta 443 deste Compose e um fallback TURN UDP/TCP; ela nao e TURN TLS e nao pode compartilhar o mesmo IP e porta com um proxy HTTPS. Para redes que exigem TLS, configure certificado no Coturn, publique `turns:` em outro IP ou porta e inclua esse endereco em `NODUS_TURN_URLS`.

Depois de salvar, abra **Configuracoes > Conexao > Testar relay**. Para testes entre redes diferentes, o status precisa mostrar `TURN pronto`.

As credenciais de acesso duram uma hora e sao geradas pelo servidor. A chave nunca deve ser colocada no aplicativo.

Para varias regioes, mantenha uma instancia Coturn por regiao com seu proprio `PUBLIC_HOST` e `PUBLIC_IP`. No servidor de coordenacao, defina `NODUS_TURN_URLS` com todos os enderecos UDP/TCP separados por virgula. O WebRTC selecionara a rota disponivel; publique tambem os endpoints na porta 443 quando a rede bloquear a porta 3478.
