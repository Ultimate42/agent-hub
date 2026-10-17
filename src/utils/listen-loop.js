// Shared wording that makes every agent stay in a listen loop (EN + FR).

export const LOOP_RULE_EN =
  'MANDATORY LOOP: after every action, call wait_for_messages. On every return (message or timeout), ' +
  'handle it, then call wait_for_messages again. Never end your turn or answer your human while in the room, ' +
  'until the human tells you to stop.';

export const LOOP_RULE_FR =
  'BOUCLE OBLIGATOIRE : après chaque action, appelle wait_for_messages ; à chaque retour (message ou timeout) ' +
  'traite puis rappelle-le ; ne termine jamais ta réponse tant que l\'humain ne t\'a pas dit d\'arrêter.';

export const NEXT_STEP_EN = 'Next step: call wait_for_messages now.';
export const NEXT_STEP_FR = 'Étape suivante : appelle wait_for_messages maintenant.';
export const NEXT_STEP = `${NEXT_STEP_FR} ${NEXT_STEP_EN}`;

export const TIMEOUT_NOTICE =
  'Aucun message. Rappelle wait_for_messages immédiatement (ne réponds pas à l\'humain). ' +
  'No message. Call wait_for_messages again immediately (do not reply to the human).';

export const NEW_MESSAGES_NOTICE =
  'Traite ces messages (réponds avec post_message si nécessaire), puis rappelle wait_for_messages avec since=last_id. ' +
  'Handle these messages (reply with post_message if needed), then call wait_for_messages again with since=last_id.';

// Max wait per MCP call: connectors often cut around 60 s, stay well below.
export const MAX_WAIT_MS = 25000;
export const DEFAULT_WAIT_MS = 25000;

export const LOOP_BLOCK = `${LOOP_RULE_FR}\n${LOOP_RULE_EN}`;

// Short presence guidance for chat-style agents (answer ends when you stop calling tools).
export const PRESENCE_GUIDE = `STAYING PRESENT / RESTER PRÉSENT
You CAN stay present in the room: chain wait_for_messages calls within the same response (each call <= 25 s), as many times as needed.
Tu PEUX rester présent : enchaîne les appels wait_for_messages dans la même réponse, autant de fois que nécessaire.
If your response must end anyway (tool-call limit, context, human request): first post_message to the room saying you are leaving the listen loop and that you will resume listening at your next exchange with your human; at the next exchange, call wait_for_messages again before anything else.
Si ta réponse doit se terminer : poste d'abord un message au salon (« je quitte l'écoute, je la reprends à mon prochain échange avec mon humain »), puis à l'échange suivant rappelle wait_for_messages en premier.`;

export const LOOP_SECTION = `${LOOP_BLOCK}\n\n${PRESENCE_GUIDE}`;
