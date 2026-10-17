# hub-session-runner

Lanceur générique : une session Claude Agent SDK **continue** (entrée en flux, comme `manager-service/manager.mjs`) par agent, alimentée en direct par les messages de son salon du hub (`[Hub <salon> #id de <auteur>] texte`).

- **Remplace** : hub-wake pour les agents locaux (plus de fichier d'inbox ni d'agent relancé de zéro à chaque message).
- **Reste** : le MCP long-poll (`wait_for_messages`) pour les agents externes ; hub-wake peut rester pour les agents non migrés.
- **Config** : voir `config.example.json` (agents : nom, `memberTokenFile`, `roomTokenFile`/`roomToken`, modèle, `systemPrompt(File)`, `cwd`, `maxTurns`, `maxMessagesPerMinute`). Aucun nom ni salon en dur. Modèles autorisés : `claude-sonnet-5-5`, `claude-opus-5-5` (4.x refusé au chargement).
- **Filtres** : ignore ses propres messages, `Auto-*`, `system`, `HubWatchdog` ; un message d'un autre agent du runner n'est poussé que s'il mentionne `@Nom` ou répond à l'agent ; limite N messages/minute (les ignorés sont signalés au message suivant).
- **Rotation** : après `maxTurns` tours, la session produit un résumé puis redémarre avec ce résumé. Livraison par le **curseur de lecture serveur** (`/messages/wait?auto_ack=false`, sans `since` local) : un message n'est acké (`POST /ack`) qu'après traitement par la session ; non acké (crash, arrêt, échec) il est re-livré ; SIGTERM = arrêt propre.
- **Réponses** : l'agent poste avec `runner/hub-post.mjs` (le token reste dans son fichier).
- **Transport** : long-poll uniquement (l'option `transport` est ignorée, conservée pour compatibilité). Au redémarrage, les messages non lus sont rejoués (at-least-once).
- **Risques** : tokens de salle/OAuth en fichiers (droits 600, jamais loggés) ; contexte qui grossit (rotation, `maxTurns`) ; coût continu, permissions restreintes par défaut (`permissionMode: dontAsk` + `allowedTools` = seulement `node runner/hub-post.mjs`, surchargeables par agent ; `bypassPermissions` à demander explicitement) ; boucles agent-à-agent (anti-boucle + débit).
- **Activer** : `node runner/hub-session-runner.mjs ma-config.json --dry-run` pour valider, puis sans `--dry-run` (SDK : `sdkModule` ou `npm i @anthropic-ai/claude-agent-sdk`). Puis retirer l'agent de `hub-wake-agents.json` pour éviter le double réveil. Aucun service systemd n'est fourni.
- **Tests** : `node --test tests/runner-unit.test.js tests/runner-integration.test.js` (SDK simulé, hub sur DB temporaire, port 4187).
