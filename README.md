# Bird Connection Kit

Recorte de módulos da conexão WhatsApp e patches locais para **Baileys 7.0.0-rc14**, com testes offline. Este repositório começa com um único commit inicial; não inclui histórico do projeto de origem, credenciais, sessões ou dados reais.

## Uso e licença

O código próprio deste recorte está sob MIT: pode usar, modificar e usar comercialmente, mantendo o aviso da licença. As partes de código upstream presentes nos diffs mantêm a licença MIT da Baileys, incluída em `licenses/Baileys-MIT.txt`. Não há concessão de direitos sobre outros produtos ou repositórios.

## Executar os testes

Requisitos: Node **22.23.4 ou posterior na linha 22**, npm e Git.

```bash
npm ci --ignore-scripts
npm test
npm run patches:check
```

Os testes usam apenas identidades, mensagens, QR fictício e chaves temporárias geradas durante a execução. Não conectam ao WhatsApp e não medem estabilidade ou capacidade de números reais. `npm ci` precisa de acesso ao registro de dependências; a execução dos testes é local.

Validação desta entrega: **18 testes aprovados**, incluindo aplicação dos diffs ao pacote original, limites de histórico e revogação de autorização durante retransmissão.

## Patches: problema resolvido em uma linha

- `patches/0001-history-bounds.patch`: limita histórico a quatro operações admitidas, uma transferência por vez, timeout de 15 s, 4 MiB comprimidos e 16 MiB descomprimidos, reduzindo picos de memória.
- `patches/0002-live-message-classification.patch`: trata `offline="0"` como mensagem ao vivo, evitando confundir eventos `notify` com histórico `append`.
- `patches/0003-retry-authorization.patch`: preserva o orçamento de retransmissão e obriga a consulta de conteúdo autorizado por `getMessage`, inclusive imediatamente antes de retransmitir após reparo de sessão.

Os arquivos são diffs contra a distribuição original `@whiskeysockets/baileys@7.0.0-rc14`, aplicados na ordem numérica. Não incluem o código inteiro da biblioteca. Marcadores dos patches usam nomes neutros.

Para aplicar à dependência desta instalação:

```bash
npm run patches:check
npm run patches:apply
```

O aplicador verifica a versão e o conjunto completo antes de escrever. Rejeita alterações incompatíveis e não reaplica um conjunto já aplicado. Não é executado automaticamente por `npm ci`. Para testar novamente os diffs sobre a base original, reinstale com `npm ci --ignore-scripts`. Reavalie cada patch ao atualizar a Baileys.

## Módulos

### Identidade LID e telefone

`src/phone-identity.mjs` exporta `resolvePhoneIdentity(message, lookup)`:

1. Aceita um JID de telefone válido.
2. Para LID, prefere `remoteJidAlt` de telefone fornecido pelo SDK.
3. Caso necessário, consulta o mapeamento confiável do SDK, por exemplo `socket.signalRepository.lidMapping.getPNForLID(lid)`.
4. Sem correspondência válida, retorna `null`. Nunca transforma os dígitos do LID em telefone.

O módulo resolve a direção LID → telefone usando o índice mantido pelo SDK. Não cria um cadastro bidirecional próprio nem exporta um resolvedor telefone → LID. O consumidor deve preservar e atualizar o índice nativo, sem criar associações por semelhança de números.

### Reconexão e limites de retransmissão

`src/connection-policy.mjs` exporta `reconnectDecision`, `createMessageRetryBudget` e a política explícita de ignorar grupos.

| Código fatal para a política local | Significado na Baileys |
| --- | --- |
| 401 | loggedOut |
| 403 | forbidden |
| 411 | multideviceMismatch |
| 440 | connectionReplaced |
| 500 | badSession |

Esses códigos interrompem a reconexão automática; não apagam a sessão. A aplicação deve mostrar que é necessária atenção do operador. Os demais códigos entram em backoff de 15 s até base de 300 s, com jitter de ±10%, por até seis tentativas instáveis. Após cinco minutos conectado, a contagem reinicia. O código 515 (`restartRequired`) passa pela política de tentativa; não é fatal nesta implementação.

`reconnectDecision` calcula a decisão; o consumidor agenda a próxima tentativa, encerra o socket antigo e cancela tentativas após pausa/logout. O gerenciador completo de instâncias e sua fila de trabalhos não fazem parte deste recorte.

`src/phone-resend-cache.mjs` limita pedidos de recuperação ao telefone, separadamente do orçamento por mensagem: quatro pedidos a cada dez minutos por cache/conta, com retenção de entradas por até 24 horas. Mantenha um cache por conexão/conta.

### Sessão cifrada

`src/session-storage.mjs` fornece arquivos de autenticação e o adaptador `encryptedMultiFileAuthState`:

- AES-256-GCM, nonce aleatório e autenticação vinculada à instância, nome de arquivo e identificador da chave.
- Gravação atômica com arquivo temporário, flush e serialização por arquivo dentro do processo.
- Chaveiro com chave ativa e chaves anteriores para leitura; gerar chaves reais fora do repositório.
- Recusa estado existente corrompido/incompatível; não cria um novo QR silenciosamente nesse caso.
- Recuperação do índice `device-list` a partir de registros Signal autenticados existentes.
- Migração legada somente offline, com preflight e aplicação explícita.

O módulo permite uso legado sem cifra quando chamado sem chaveiro; isso existe para compatibilidade. No adaptador compartilhado, forneça sempre um chaveiro válido: `allowLegacy` é `false`. Se usar `sessionKeyringFromEnv`, configure `BIRD_SESSION_KEY_FILE` e `BIRD_SESSION_ENCRYPTION_REQUIRED=true` e interrompa o início do serviço se a chave não estiver disponível. O diretório e os caminhos ancestrais devem ser privados e controlados pelo processo. Use um processo por diretório de sessão; a serialização é local ao processo. Mantenha backup cifrado dos arquivos e das respectivas chaves, fora do Git.

### Adaptador e transporte simulado

`src/baileys-transport.mjs` conecta a sessão ao SDK e aos callbacks `onConnection`, `onMessage`, `onReceipt`, `onFailure` e `getMessage`. Usa logs silenciosos, não importa histórico e ignora grupos, broadcasts e newsletters. A entrada opcional `sdkFactory` foi acrescentada a este recorte para permitir testes com SDK falso; o caminho padrão continua usando a Baileys.

`tests/helpers/simulated-transport.mjs` transforma o padrão de transporte injetado dos testes em uma fábrica independente. Permite emitir conexão/QR fictício, mensagens e recibos, registrar envios, simular resultado incerto e distinguir pausa de logout. Não é uma implementação de protocolo WhatsApp.

O adaptador é uma camada de conexão. O sistema consumidor precisa implementar autorização dos contatos/grupos, persistência e deduplicação de eventos, fila de envio e revisão humana quando o resultado é incerto. Implemente `getMessage` verificando destinatário, vínculo com a instância e autorização atual em cada chamada; caso contrário o patch não fornece essa política sozinho. O envio de baixo nível não deve ser exposto diretamente a usuários ou agentes sem essas verificações.

## Integração mínima

Importe os módulos pelo caminho local e injete callbacks e chaveiro da sua aplicação. No `onConnection`, quando houver fechamento, leia `update.lastDisconnect?.error?.output?.statusCode`, consulte `reconnectDecision` e aplique sua política de operador/agenda. Para grupos, crie explicitamente a política de autorização e o processamento próprio; o adaptador atual os ignora.

Este repositório entrega somente os módulos e testes descritos. Não contém CRM, agente de IA, banco de clientes, acesso a serviços hospedados, Docker ou credenciais de produção.
