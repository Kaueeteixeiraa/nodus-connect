# Servidor auxiliar Nodus

Requer uma maquina Linux com IP publico e Docker. Copie `.env.example` para `.env`, preencha dominio, IP e uma chave longa, libere TCP/UDP 3478, TCP 443 e UDP 49160-49200, depois execute:

```bash
docker compose --env-file .env -f compose.yml up -d --build
```

Se a instalacao usar o binario legado, o comando equivalente e `docker-compose --env-file .env -f compose.yml up -d --build`.

No Nodus, informe `http://SEU_DOMINIO:8787` em **Configuracoes > Conexao > Servidor auxiliar** ou compile com `VITE_NODUS_API=https://SEU_DOMINIO` quando existir um proxy HTTPS para a API. A porta TCP 443 deste Compose e um fallback TURN TCP; ela nao e TURN TLS e nao pode compartilhar o mesmo IP e porta com um proxy HTTPS. Para ambientes que bloqueiam TCP sem TLS, adicione um listener `turns:` com certificado publico e use esse endereco em `NODUS_TURN_URLS`.

Depois de salvar, abra **Configuracoes > Conexao > Testar relay**. Para testes entre redes diferentes, o status precisa mostrar `TURN pronto`.

As credenciais de acesso duram uma hora e sao geradas pelo servidor. A chave nunca deve ser colocada no aplicativo.

Para varias regioes, mantenha uma instancia Coturn por regiao com seu proprio `PUBLIC_HOST` e `PUBLIC_IP`. No servidor de coordenacao, defina `NODUS_TURN_URLS` com todos os enderecos UDP/TCP separados por virgula. O WebRTC selecionara a rota disponivel; publique tambem os endpoints na porta 443 quando a rede bloquear a porta 3478.
