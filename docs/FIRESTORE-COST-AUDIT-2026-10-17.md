# Firestore: auditoria de consumo em 2026-10-17

Escopo: copia local da `main`, preservando os ajustes anteriores. Nenhum deploy,
push, instalacao, mudanca de cota, faturamento ou ativacao em producao.
As alteracoes deste registro NAO estao no setup 1.1.28 gerado anteriormente.

## Volume e precos verificados

- Informacao inicial: 2.000 sessoes/mensais de 30 minutos.
- Volume detalhado: 15 PCs iniciadores x 20 sessoes/dia = 300/dia,
  6.600 em 22 dias uteis ou 9.000 em 30 dias. Sao 150 horas de sessao/dia;
  20 sessoes sequenciais exigem 10 horas por tecnico. PCs receptores tambem contam.
- Metadados consultados, sem ler documentos: banco `(default)` Standard,
  `southamerica-east1` (Sao Paulo), com free tier habilitado.
- Lista publica BRL consultada no navegador em 17/10: leitura R$ 0,266892363
  por 100.000 (SKU B7EC-27C1-4D9B); escrita R$ 0,80067709 por 100.000
  (SKU 631D-EC9D-B916). Usar as SKUs reais da fatura para fechar o orcamento.
- Franquia: 50.000 leituras, 20.000 escritas e 20.000 exclusoes por dia.
  Nao acumula entre dias. Armazenamento e trafego possuem franquias separadas.

Fontes: [precos e cobranca](https://firebase.google.com/docs/firestore/pricing),
[tabela regional](https://cloud.google.com/firestore/pricing),
[SKUs em reais](https://cloud.google.com/skus?currency=BRL).

## Fontes de consumo

| Fluxo | Fonte e impacto |
| --- | --- |
| Presenca | `App.tsx` publica a cada 30 s, mesmo ocioso. Cada PC aberto 10 h gera cerca de 1.200 escritas/dia, mais leituras da regra de propriedade. |
| Catalogos | Cada observador recebe outra leitura por atualizacao de presenca. 15 dispositivos observados por 15 PCs durante 10 h representam aproximadamente 270 mil entregas/dia. |
| Bloqueio proprio | O listener dependia do documento volatil de presenca; isso podia provocar reavaliacoes das regras a cada heartbeat. |
| Licenciamento empresarial | Ambos os participantes validam a cada 30 s, com rate limiter distribuido, dispositivo, hardware, politica e licenca. |
| Autorizacoes | Regravar o grant em cada heartbeat provoca reavaliacoes dos listeners de sinais, mesmo sem novos candidatos. |
| ICE | Cada candidato individual repetia a avaliacao das mesmas dependencias de seguranca. |
| Admin | Resumos, contagens, hidratacao de dispositivos e refresh continuam cobrando. Pagina oculta ja pausa refresh; Admin aberto todo dia entra no orcamento. |
| Video/input/arquivos | Trafegam por WebRTC/relay, nao por documentos Firestore. TURN, API e hospedagem nao estao incluidos nestes precos. |

## Ajustes implementados

- Catalogos deixam de observar presenca enquanto todas as janelas estao ocultas
  e na tela de sessao remota. Pedidos recebidos, autorizacao e sinais continuam ativos.
- Observadores voltam ao exibir o catalogo; janelas auxiliares visiveis sao consideradas.
- O bloqueio proprio usa a propriedade estavel de `deviceClaims`, mantendo fallback
  para dispositivos antigos e negando o proprietario anterior apos transferencia.
- ICE usa micro-lotes de ate 20 documentos, janela maxima programada de 8 ms.
  SDP nao espera o lote. Formato e quantidade dos documentos nao mudam: o ganho
  potencial esta nas regras/requests, nao em transformar 20 escritas em uma.
- Encerramento com identidade conhecida dispensa leitura redundante de presenca.
- Leituras repetidas no mesmo snapshot transacional compartilham o resultado;
  nao ha cache de autorizacao entre transacoes e os retornos sao clonados.
- Renovacoes empresariais proximas continuam verificando bloqueio dos dois lados,
  mas persistem apenas uma renovacao por intervalo. Grants estaveis nao sao
  regravados em heartbeats; transicao, prazo e encerramento continuam publicados.
- Encerramento repetido verifica participante e sessao, sem reler licenca/politica.

## Empresarial por eventos: preparado, desativado

`LICENSE_BUSINESS_EVENTS_READY` permanece falso/ausente. O servidor so aceita
o modo se o iniciador pedir a capacidade e o receptor anunciar `license-events-v1`.
Clientes antigos, QuickSupport e offline mantem suas validacoes existentes.
Gratuito mantem dez minutos, contagem por iniciador e direito de receber acesso.

No modo novo, cada participante acompanha o grant e um registro de controle
estavel. O controle contem somente `blocked` e `ownerUid`, sob ID opaco; permite
get autenticado, mas nao listagem nem escrita pelo cliente. O grant e legivel
somente pelos dois participantes. Hardware, tokens e provas nao sao publicados.
Bloquear qualquer alias fisico atualiza o mesmo controle. Reinstalacao/enrollment
troca o responsavel, invalidando a sessao anterior. Apenas o servidor os grava.

Uma tentativa baseada somente em dependencias das regras NAO passou no emulador:
alterar o documento dependente nao encerrou o listener existente. Foi substituida
pelos listeners diretos, testados com bloqueio real do engine e alias de hardware.

Sessoes estabelecidas continuam ocupando capacidade ate encerrar. Se ambos os
PCs perderem o cleanup, o slot nao e liberado por suposicao: Admin pode reconcilia-lo,
com justificativa e auditoria. Nao ha acesso excedente por expiracao ficticia.

## Medicao reproduzivel

`services/licensing/src/engine.test.ts`: laboratorio de 30 minutos simulados,
123 chamadas HTTP no legado (reserva, dois ACKs, 118 heartbeats e dois fins).
Contadores incluem rate limiter e transacoes, nao SDK, regras, transporte ou retries.

| Licenciamento empresarial | Leituras | Escritas |
| --- | ---: | ---: |
| Fluxo anterior, hardware ligado: calculo pelo codigo, nao fatura medida | 735 | 490 |
| Otimizado com heartbeats, sem hardware: medido | 612 | 254 |
| Otimizado com heartbeats, hardware ligado: medido | 733 | 254 |
| Eventos, hardware ligado: medido, cinco chamadas HTTP | 26 | 18 |

O ultimo caso ainda tem leituras de listeners e regras. A reducao de 96,5% nas
leituras HTTP de licenciamento NAO e uma reducao de 96,5% na conta inteira.
QuickSupport continua com heartbeat e validacao de revogacao/validade do perfil.

## Projecao ilustrativa, nao teto de cobranca

Hipoteses explicitas: 22 dias, 30 publicadores de presenca abertos 10 h/dia
(15 tecnicos e 15 receptores), 300 sessoes/dia no caso maior, todos no Nodus normal
compativel com eventos. Por sessao: 223 leituras e 64 escritas como premissa de
planejamento, incluindo HTTP, SDK, regras e sinalizacao; NAO sao medicoes reais.
Sinalizacao suposta: 40 documentos, oito grupos de entrega/commit e margem de
100 leituras para descoberta, pedidos e inicializacao. Acrescentados 720 leituras
de catalogo e 3.000 de Admin por dia. Sem novas instalacoes em massa ou reconexoes.

| Sessoes/mes | Leituras totais | Escritas totais | Operacoes cobradas apos franquias diarias: estimativa BRL |
| --- | ---: | ---: | ---: |
| 2.000 distribuidas nos 22 dias | 1.319.840 | 920.000 | R$ 4,43 |
| 6.600, 300 por dia util | 2.345.640 | 1.214.400 | R$ 9,52 |

Cada um desses dias supera as franquias, permitindo subtrair a franquia diaria
na soma apenas para estes exemplos. Em distribuicoes diferentes, calcular dia a dia:
`max(leituras - 50000, 0) * 0.266892363 / 100000 + max(escritas - 20000, 0) * 0.80067709 / 100000`.

Excluir destes valores: armazenamento acima da franquia, egress, exclusoes acima
da franquia, Vercel, Auth, relay/TURN, impostos/contratos diferentes e picos/retries.
Mais PCs ociosos, catalogos ou QuickSupport podem elevar bastante o total.
Logo, R$ 5 e plausivel no primeiro modelo, NAO garantido para o volume informado.

## Ativacao e verificacao pendentes

1. Testar nos dois PCs a conexao normal, bloqueio/unbloqueio de ambos os lados,
   alias apos reinstalacao, perda de rede, encerramento e recuperacao de slots.
2. Publicar regras, API e clientes compativeis somente apos autorizacao.
   Ativar a flag apenas apos conferir as regras/controles; nunca antes.
3. Medir 24-72 h com volume conhecido, separando sessoes normais e QuickSupport,
   PCs-hora ociosos, quantidade de observadores, picos e tempo de Admin aberto.
4. Comparar metricas do console e SKUs da fatura com o modelo. Os contadores
   locais excluem regras e operacoes do servidor; testes nao comprovam fatura.

NAO VALIDADO EM AMBIENTE REAL. Nenhuma garantia de teto mensal; alertas de
orcamento nao sao bloqueio automatico de cobranca. Nao cortar seguranca para caber no modelo.

Verificacao final local: 632 testes aprovados, sem falhas; mais 19 testes de
regras/integracao aprovados separadamente no emulador. TypeScript, build Desktop
e build API aprovados. Nenhum setup novo foi gerado e nenhuma publicacao realizada.
