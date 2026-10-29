# CLAUDE.md — shopify-helper-back

Backend du helpdesk e-commerce COD « ecom_helper » : `src/` (Node 22, TypeScript, Express,
Mongoose/MongoDB, BullMQ/Redis, Jest). Le front est un autre dépôt
(`shopify-helper-front`, Vue 3) qui consomme l'API REST `/api/*` ; ses types
(`src/types/*.ts`) recopient à la main les enums de `src/models/*`. Vérification : CI
GitHub Actions (`.github/workflows/ci.yml` : `npm ci` → `npm run build` → `npm test`,
Node 22) sur chaque PR et chaque push vers `dev` / `main`.

## Démarrer

```bash
npm ci                                          # Node 22, comme les images Docker
cp .env.example .env                            # seulement pour lancer l'API : les tests n'en ont pas besoin
docker compose -f docker-compose.dev.yml up     # API (ts-node-dev, port 3600) + Redis
```

Le conteneur de dev monte **le checkout principal** et recharge à chaque modification.
Travailler dans un worktree (`.claude/worktrees/<tâche>`), jamais dans le checkout
principal : sinon on modifie l'API que l'humain est en train d'utiliser.

## Commandes

```bash
npm run build      # tsc : doit passer, c'est la vérification de types
npm test           # jest --runInBand : MongoDB et Redis sont simulés, aucun service ni .env requis
npx jest src/utilities/services/orderConfirmation.service.test.ts   # un seul fichier
```

`npm run lint` échoue déjà sur `dev` (ESLint 9 installé sans fichier de configuration) :
ne pas le corriger dans une tâche, ne pas le compter comme une régression.

## Données et secrets

- `.env` contient de vrais secrets (MongoDB Atlas, jetons Meta) : ne jamais l'afficher, le
  copier ni le committer. Un jeton Meta a déjà été compromis sur ce projet.
- La base pointée par `.env` contient les données de test de l'humain, liées à ses vrais
  numéros WhatsApp : aucun script ni aucune écriture dessus sans son accord.

## Backend — ce qui casse en silence

**Motif « À traiter ».** Ajouter une valeur à `AttentionReasonCode` (`src/models/Order.ts`)
impose aussi : les compteurs écrits en dur de la file (`src/controllers/order.controller.ts`,
objet `{ free_text: 0, … }`), le filtre `reason`, la doc Swagger (`src/docs/swagger.config.ts`,
`src/docs/routes/helpdesk.docs.ts`) et le front (`types/attention.ts`, `stores/attention.ts`,
`views/ATraiterView.vue`). Sinon la commande existe mais n'apparaît dans aucun onglet. Même
règle pour tout enum exposé par l'API.

**Confirmer une commande.** Toutes les confirmations passent par
`OrderConfirmationService.confirmByWhatsAppButton` ou `confirmByAdmin`
(`src/utilities/services/orderConfirmation.service.ts`) ; la confirmation groupée appelle
`confirmByAdmin` pour chaque commande. Un effet « à la confirmation » se branche là, pas
dans les contrôleurs. La transition de statut est atomique (`findOneAndUpdate` conditionné
au statut courant) : garder ce modèle pour toute transition.

**Files BullMQ.** Un job lié à une commande a un `jobId` déterministe : rejouer un webhook ne
doit jamais doubler un envoi. Un échec d'enqueue ne fait jamais échouer la requête qui l'a
déclenché. Modèles : `src/queues/notification.queue.ts`, `src/workers/notification.worker.ts`.

**Webhook Shopify.** Shopify peut rejouer un webhook : l'ingestion
(`src/controllers/shopifyWebhook.controller.ts`) reste idempotente. Les attributs EasySell
(UTM, `full_url`…) arrivent dans `noteAttributes`.

**Webhook WhatsApp.** `src/controllers/whatsappWebhook.controller.ts` alimente aussi le
miroir Chatwoot (`src/utilities/services/chatwootForward.service.ts`) : un nouveau
traitement d'un message entrant ne doit pas court-circuiter ce transfert.

**Téléphones.** Toujours normaliser avec `src/utilities/services/phoneNormalization.service.ts`
avant de comparer ou de stocker (`+221…` en base) : un formulaire envoie `776986780`, la
commande contient `+221776986780`, et une comparaison brute échoue sans erreur.

**Doc Swagger.** Une route ou un enum exposé se déclare dans `src/docs/` ;
`src/docs/swagger.config.test.ts` valide la spécification.

**Tests.** Jest + `ts-jest`, fichiers `*.test.ts` à côté du code testé. Les modèles Mongoose
sont simulés (`jest.spyOn(Order, 'findOneAndUpdate')…`) et les files par
`jest.mock('../../queues/notification.queue', …)`. Modèles :
`src/utilities/services/orderConfirmation.service.test.ts`,
`src/controllers/order.controller.test.ts`.

## Critères hors du cas normal

- Webhook ou job rejoué deux fois → aucun doublon (envoi, événement, écriture).
- Deux écritures concurrentes sur la même commande → la transition reste correcte
  (écriture conditionnelle).
- Service externe (Meta, WhatsApp, Redis) en panne ou lent → la confirmation et la
  livraison n'échouent pas.
- Entrée absente, vide ou invalide → `400` avec un code d'erreur explicite, sans écriture.
- Commande introuvable → `404` ; transition interdite → `409`.
- Variable d'environnement absente → valeur par défaut ou fonctionnalité coupée, jamais
  de plantage silencieux.

## Git, commits, PR

- **Langue** : code, commentaires et messages de commit en anglais ; textes visibles par
  l'utilisateur, documentation et PR en français.
- **Branches** : depuis `dev`, une par tâche : `feature/<id>-<sujet>`, `fix/<sujet>`,
  `test/<sujet>`, `chore/<sujet>` (ex. `feature/c5-1-capi-model-config`).
- **Message de commit** : Conventional Commits, scope `back` (`feat(back): add …`). Corps :
  le pourquoi. Pour une tâche de mission tech lead, pied de page `Tâche:`, `Agent:`,
  `Review:`, puis la ligne `Co-Authored-By`.
- **Description de PR**, vers `dev` : `## Contexte` (carte Trello), ce qui change,
  `## Vérifications` (commandes et résultats chiffrés), points d'attention ; dernière ligne
  d'attribution. Modèle : PR #13.
- **Fusion** : par l'humain uniquement. Commit, push de branche et ouverture de PR sont
  permis ; jamais de fusion.
- **Trello** (tableau ecom_helper) : la carte passe en « En Cours » au démarrage, en
  « En validation » à l'ouverture de la PR, en « Terminés » une fois fusionnée.
- **Preuve attendue** : sortie réelle de `npm run build` et de `npm test` (nombre de suites et
  de tests) ; pour un correctif, le test qui échoue sans lui.

## Où regarder

- Cartes Trello du tableau ecom_helper — le détail de chaque tâche ; la carte fait foi.
- `../docs/SPEC_MASTER_ecom_helper.md` (hors dépôt) — spécification de référence des lots
  et du Chantier 5.
- `../docs/CHANTIER5_PROPOSITIONS_MAJ.md` (hors dépôt) — décisions du Chantier 5 (devise,
  valeur envoyée, `action_source`, capture navigateur, limites connues).
- `../techlead/<mission>/` (hors dépôt) — PLAN et JOURNAL des missions tech lead.
- `README.md`, `PLAN_mvp.md`, `Implement_mvp.md` — documents de conception d'origine :
  vérifier dans le code avant de s'y fier.
