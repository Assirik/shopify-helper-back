# Chantier 5 — Meta CAPI et anti-fraude WhatsApp : statut au 03/11/2026

Le code du Chantier 5 et de l'observabilité (journal des requêtes, Sentry, Axiom) est
fusionné dans `dev` (back et front). La CAPI reste coupée (`META_CAPI_ENABLED=false`)
jusqu'à la bascule, qui est une suite d'actions humaines décrite plus bas. Le détail de
chaque tâche est sur sa carte Trello (tableau ecom_helper), qui fait foi.

## Ce que fait le chantier

Les fausses commandes COD faussent l'optimisation Facebook. Désormais :

- **Une vente n'est déclarée à Meta (« Purchase ») qu'une fois confirmée**, par le serveur
  seul, avec un secours à la livraison. Elle part une seule fois (`event_id` stable), en
  euros (parité 655,957), sur le prix des articles après remise et sans livraison, avec les
  données client hachées et les signaux du navigateur capturés par le thème.
- **Un envoi ignoré ou en échec a une seconde chance** : reprise automatique d'une commande
  ignorée parce qu'annulée, puis reconfirmée ou livrée ; relance par un admin d'un envoi en
  échec, ou ignoré parce que la CAPI était coupée. Jamais plus de 47 h après une tentative que
  Meta a pu recevoir (au-delà, Meta ne dédoublonne plus).
- **Le client confirme en un clic sur WhatsApp** : message pré-rempli par EasySell, reconnu
  seulement s'il correspond au modèle configuré et vient du numéro de la commande. Sinon, la
  commande part en « Numéro différent » et ne se confirme plus que par un appel d'agent,
  verrou côté serveur compris.
- **La première demande WhatsApp part à T+5 min**, et seulement si le client n'a pas déjà
  confirmé. Une commande confirmée n'est jamais redemandée ni rétrogradée.
- **Ce qui se passe en production se lit** : chaque requête a sa ligne de journal et un
  `x-request-id` ; les erreurs du code arrivent dans Sentry ; tous les logs partent dans
  Axiom. Les jetons, les signatures et les données client du webhook Shopify y sont
  masqués.

## Livré

| Carte | Objet | PR back | PR front |
|---|---|---|---|
| C5.1 | Modèle, champs CAPI et configuration | #16 | — |
| C5.2 | Origine publicitaire (`utm_*`, `fbclid`) | #20 | — |
| C5.3 | Module d'envoi Meta (EUR, hachage, `action_source`) | #17 | — |
| C5.4 | File et worker Purchase, balayage | #21 | — |
| C5.5 | Déclenchement à la confirmation, secours à la livraison | #25 | — |
| C5.6a | Première demande à T+5 min | #22 | — |
| C5.6b | Message pré-rempli contrôlé par numéro, motif « Numéro différent » | #18 | — |
| C5.7 | Seconde chance d'un envoi Meta : reprise automatique, relance par un admin | #36 | #17 |
| C5.8 | Écrans : conversion Meta, origine pub, onglet « Numéro différent » | — | #12 |
| C5.12a / b | Capture navigateur (route `/api/session`, script du thème) | #19, #15, #28 | — |
| C5.13 | Jamais redemander ni rétrograder une commande confirmée | #26 | — |
| C5.15 | Redis injoignable : webhook jamais bloqué, motif « Demande non envoyée » | #24 | #13 |
| C5.16 / C5.17 | Confirmation tardive par l'agent seul ; message reconnu par modèle | #31 | — |
| C5.18 | T+5 sauté seulement si une relance a atteint le client | #30 | — |
| C5.19 | Pas de Purchase pour une commande annulée ; interrupteur CAPI strict | #29 | — |
| C5.20 | Messages non envoyés en neutre ; détails « Numéro différent » | — | #14 |
| C5.23 | « Numéro différent » : confirmation par appel uniquement (marqueur durable) | #33 | #15 |
| C5.24 | Purchase seulement si confirmée ou livrée ; plus de rétrogradation sous concurrence ; modèle visible au démarrage | #34 | — |
| C5.25 | Écran à jour après un refus « par appel » | — | #16 |
| C5.26 | Avertissements renvoyés par Meta CAPI (champ `messages`) journalisés | #37 | — |
| OBS.1 | Journal de chaque requête (pino-http), `x-request-id`, rotation des logs Docker | #38 | — |
| OBS.2 | Erreurs de l'API et échecs définitifs des jobs dans Sentry, nettoyés | #39 | — |
| OBS.3 | Logs vers Axiom ; téléphones, noms et e-mails masqués dans les logs du webhook Shopify | #40 | — |
| Tests C5 | Parcours de bout en bout et tests manquants | #32 | — |
| Divers | Suppression du script de rattrapage, tests des préfixes 71/72/79, statut du chantier | #23, #27, #35 | — |

Vérification : sur `dev` (aea3d21), la CI passe (`npm run build` OK, `npm test` 52 suites /
1062 tests verts). Chaque PR a été relue par un autre modèle que son auteur. Les deux chasses
aux bloquants du 01/11 (4 puis 2 relecteurs, sur une vraie API avec bases jetables)
couvraient `dev` jusqu'à 7eaf3a0 : aucun bloquant restant. Ce qui a été fusionné depuis
(C5.7, C5.26, OBS.1 à OBS.3) passera par une nouvelle chasse juste après la réouverture des
ventes (voir « Points ouverts »).

## Bascule : actions humaines, dans l'ordre

1. **Jetons** :
   - révoquer le jeton Meta exposé le 29/10 ;
   - générer le jeton Conversions API du dataset (pas le jeton WhatsApp) et noter
     l'identifiant du dataset. Le jeton CAPI apparu sur une capture d'écran le 02/11 est à
     régénérer, si ce n'est pas déjà fait ;
   - WhatsApp : un jeton **permanent** d'utilisateur système. Le 401 du 02/11 laisse penser
     à un jeton temporaire expiré.
2. **Après un long arrêt, avant le premier `up`**. Le contrôle du 03/11 a donné 0 et 0 sur la
   base de l'API, sans compter la file `active` : la compter avant le premier `up`.
   - **commandes anciennes encore « en attente »** : la relance automatique (toutes les
     30 min, jusqu'à 200 commandes par niveau de relance) les reprendrait quel que soit leur
     âge. Requête en lecture seule, **sur la base que l'API utilise** : `MONGODB_DB_NAME` du
     `.env` de production, ou `starter-kit` si la variable est absente. Ce nom l'emporte sur
     celui de l'URI. Contrôle préalable : `db.orders.estimatedDocumentCount()` doit être
     supérieur à 0 sur cette base. Le résultat de la requête doit être 0 :
     `db.orders.countDocuments({ customerConfirmationStatus: "pending", reminderCount: { $lt: 2 }, createdAt: { $lte: new Date(Date.now() - 24*3600*1000) }, shopifyCancelledAt: null })` ;
   - **jobs restés dans le Redis de production**, qui est persistant : démarrer Redis seul
     (`docker compose -f docker-compose.prod.yml up -d redis`), puis
     `docker exec shopify-helper-redis sh -c 'redis-cli -a "$REDIS_API_PASSWORD" --no-auth-warning LLEN bull:notifications:wait; redis-cli -a "$REDIS_API_PASSWORD" --no-auth-warning LLEN bull:notifications:active; redis-cli -a "$REDIS_API_PASSWORD" --no-auth-warning ZCARD bull:notifications:delayed'`
     doit afficher 0 trois fois.
3. **Front** : déployer `dev` (Netlify) avant le back ou en même temps, et faire recharger
   tous les onglets du helpdesk restés ouverts (un ancien front plante sur un motif inconnu).
4. **`.env` du back** :
   - `META_WHATSAPP_ACCESS_TOKEN` : le jeton permanent de l'étape 1. L'API ne le vérifie pas
     au démarrage : seul l'envoi réel de l'étape 9 prouve qu'il marche ;
   - `SESSION_CAPTURE_ALLOWED_ORIGINS=https://<domaine boutique>` (schéma inclus, sans
     chemin, toutes les variantes servies) ;
   - CAPI : `META_CAPI_DATASET_ID`, `META_CAPI_ACCESS_TOKEN`, `META_CAPI_ENABLED=true`
     (`true` / `false` seulement : toute autre valeur empêche l'API de démarrer), et
     `META_CAPI_TEST_EVENT_CODE` pendant la recette seulement (étape 9) ;
   - `PREFILLED_CONFIRMATION_TEMPLATE` : le texte EasySell à l'identique, la variable du
     numéro de commande remplacée par `{{order.number}}`, **entre guillemets**. Ex. EasySell
     « Je confirme ma commande #{n°} » → `"Je confirme ma commande #{{order.number}}"`.
     Ne jamais recopier `#{n°}` ; sans guillemets la valeur est coupée au `#`. Dans les deux
     cas l'API démarre mais la confirmation par message est coupée (voir étape 7) ;
   - Sentry : `SENTRY_DSN` du projet `ecom-helper-back` ; `SENTRY_RELEASE` facultatif (ex.
     le hash du commit déployé). Vide : Sentry est coupé ;
   - Axiom : `AXIOM_TOKEN` (jeton d'ingestion seule) et `AXIOM_DATASET=ecom-helper` ;
     laisser `AXIOM_URL` vide (US East 1 par défaut). Vides : les logs restent sur la
     sortie standard seulement.
5. **Retirer les restes des essais ngrok** :
   - app Meta, webhook WhatsApp (une seule URL de rappel par app) :
     `https://<API_DOMAIN>/api/webhooks/whatsapp`, et corriger l'abonnement qui pointait
     sur `/`. Sinon la production ne reçoit ni les réponses des clients ni les statuts de
     livraison ;
   - Shopify : supprimer le webhook « Création de commande » vers ngrok. Sinon chaque
     commande arrive aussi sur la machine de développement : double WhatsApp au client et
     Purchase envoyé depuis le développement ;
   - thème : étape 8.
6. **Déploiement** :
   - mettre sur le VPS le code du commit de `dev` à déployer : au moins aea3d21, ou le commit
     de fusion de C5.27 une fois celle-ci fusionnée. Avec git, dans le dossier du back :
     `git fetch origin && git checkout dev && git pull --ff-only` ; `git log -1 --oneline`
     affiche le commit déployé, qui doit être celui-ci ou un commit plus récent de `dev`
     (donc relu et fusionné). Son hash court peut servir de `SENTRY_RELEASE` ;
   - contrôle à froid sans afficher de secret :
     `docker compose -f docker-compose.prod.yml config | grep -E 'META_CAPI_ENABLED|PREFILLED_CONFIRMATION_TEMPLATE|AXIOM_DATASET'`.
     Jamais de `docker compose config` sans `grep` : il affiche tous les jetons ;
   - `docker compose -f docker-compose.prod.yml up -d --build`. Après toute modification du
     `.env` : `up -d`, jamais `restart`. Dès ce déploiement, plus de demande immédiate (T+5).
7. **Logs** (`docker logs shopify-helper-api`, une ligne JSON par événement de l'API) :
   - « CAPI purchase worker started » et « CAPI purchase sweep scheduled » ;
   - aucun `CapiNotConfigured` (sinon redémarrage en boucle, API entière coupée) ;
   - CAPI activée : « CAPI enabled » avec `"datasetPresent":true` ;
   - « Pre-filled confirmation template loaded … enabled » : comparer son champ `template`
     au texte EasySell ; une ligne « … disabled » signifie que la confirmation par message
     est coupée alors que l'API reste « healthy » ;
   - Sentry et Axiom signalent une mauvaise configuration en texte brut sur stderr, et l'API
     tourne alors sans eux :
     `docker logs shopify-helper-api 2>&1 | grep -E 'SENTRY_DSN is malformed|Sentry initialisation failed|axiom-log-transport'`
     ne doit rien afficher. Deux erreurs restent muettes : un seul de `AXIOM_TOKEN` et
     `AXIOM_DATASET` renseigné, ou un DSN bien formé mais faux. Les contrôles Sentry et Axiom
     ci-dessous les révèlent ;
   - `docker ps` : « healthy » ; `docker stats --no-stream shopify-helper-api` : mémoire
     nettement sous la limite de 512 Mo ;
   - Sentry : envoyer un événement d'essai, qui doit apparaître dans le projet :
     `docker exec shopify-helper-api node -e "const S=require('@sentry/node');S.init({dsn:process.env.SENTRY_DSN,environment:'production'});S.captureMessage('test bascule');S.flush(5000).then(()=>process.exit(0))"` ;
   - le tech lead vérifie l'arrivée des logs dans Axiom (champ `env` à `production`) et crée
     le moniteur « Meta CAPI — avertissements » sur le message
     `Meta CAPI accepted the event with warnings`.
8. **Thème** : `ENDPOINT` de `theme/session.js` vers `https://<API_DOMAIN>/api/session`,
   script avant `</body>` ; vérifier un 204 dans l'onglet Réseau avec un numéro complet de
   9 chiffres (un 403 = origine absente de la variable).
9. **Recette C5.10 / C5.14**, CAPI active et code de test renseigné, Purchase EasySell encore
   actif :
   - passer une vraie commande (`isTest:false`) depuis un téléphone de l'équipe : la demande
     WhatsApp doit arriver à T+5 min, avec le log « Order confirmation sent through Meta
     WhatsApp ». C'est la seule preuve que le jeton WhatsApp de l'étape 1 permet d'envoyer ;
   - la confirmer → fiche « Envoyée » et `purchase_<id>` ; contrôler dans Test Events et le
     dédoublonnage par `event_id` ;
   - vider le code de test, `up -d`, puis vérifier `"testEventCodePresent":false` dans la
     ligne « CAPI enabled » : la fiche affiche « Envoyée » avec ou sans code de test ;
   - le code de test se copie dans l'onglet « Tester les événements » **ouvert** du
     dataset, source « Site web ». Avec un code périmé ou pris ailleurs, Meta répond 200
     mais l'événement n'apparaît nulle part (incident du 02/11). Depuis C5.26, ce cas
     laisse dans les logs la ligne « Meta CAPI accepted the event with warnings ».
10. **Après une conversion « Envoyée » sans code de test**, côté EasySell : couper
    **uniquement** l'événement Purchase ; activer la redirection WhatsApp avec le texte qui a
    servi au modèle ; essai réel immédiat (depuis le numéro de la commande → « Confirmée » ;
    depuis un autre numéro → « Numéro différent » ; « Réponse libre » = texte et modèle
    différents) ; prévenir la personne qui gère les pubs.
11. **À savoir** : les commandes confirmées pendant que la CAPI était coupée restent
    « Ignorée » (une fois la CAPI active, un admin peut les relancer jusqu'à 6 j 23 h après
    leur confirmation, ou leur livraison : C5.7) ; celles créées avant la bascule puis
    confirmées ou livrées après auront deux Purchase (accepté le 30/10).

## Où regarder en production

- `docker logs shopify-helper-api` : tous les logs (ceux de l'API en JSON), sur 5 fichiers de
  20 Mo.
- Axiom, dataset `ecom-helper` (30 jours) : les mêmes lignes, cherchables. Pour suivre une
  commande, partir de son numéro (`shopifyOrderName`) pour trouver son `orderId`, puis
  chercher cet `orderId`. Dans les logs du webhook Shopify, les téléphones sont masqués
  (4 derniers chiffres) : on ne retrouve pas un client par son numéro.
- Sentry, projet `ecom-helper-back` : les erreurs du code (réponses 500, jobs en échec
  définitif), avec alerte par e-mail. Les avertissements de configuration n'y vont pas.

## Points ouverts

**Juste après la réouverture des ventes** (décision du 03/11 : rouvrir sans les attendre) :

- **C5.27** : délai maximal de 10 s sur les appels WhatsApp et Termii
  (`metaWhatsApp.provider.ts`, `termiiSms.provider.ts`). La file d'envoi traite un job à la
  fois : un seul appel sans réponse la fige, et plus aucune demande ni relance ne part.
- **Chasse aux bloquants** sur tout ce qui a été fusionné depuis le 01/11 (C5.7, C5.26,
  OBS.1 à OBS.3) et sur cette liste de bascule : carte « [Réouverture] Chasse aux
  bloquants ».

**Ensuite** :

- **C5.28** : SMS de secours. L'expéditeur Termii « Alkima » attend sa validation : d'ici
  là, un client sans WhatsApp n'est joint que par l'appel d'un agent. La carte porte aussi
  l'ancien point « à trancher » : un message accepté par Meta puis déclaré « échoué » par le
  webhook (ex. 131026) ne déclenche jamais de SMS ; si c'était une relance, la colonne
  « Notification » reste « Envoyée » et bloque la demande suivante.

**Actions humaines** : C5.9 (configuration EasySell), C5.10 (recette), C5.14 (vérifier que
Meta dédoublonne un même `event_id`).

**Cartes reportées** : C5.21 (actions d'agent sans attendre Redis), C5.22 (modèle du message
pré-rempli en base), renvoi avec choix du modèle, commandes Shopify test / voided relancées,
« Petits défauts », répercuter les actions du helpdesk dans Shopify (Brainstorming).

**Relevés par les relectures de l'observabilité, sans carte** (défauts antérieurs) :

- les messages d'erreur des providers Meta et Termii recopient la réponse brute
  (`JSON.stringify(response.data)`) ;
- des clés `error` sont journalisées hors du sérialiseur d'erreurs ;
- l'IP du client figure dans le journal des requêtes ;
- 7 réponses `res.status(500)` directes ne passent pas par Sentry ;
- un corps JSON mal formé reçoit 500 au lieu de 400 (`errorHandler`), sans aller dans
  Sentry ;
- la dépendance `dayjs` n'est plus utilisée.

## Limites connues, acceptées

- Plus de relance ni de reprise automatique d'un Purchase 47 h après une tentative que Meta
  a pu recevoir : au-delà, un renvoi risquerait d'être compté deux fois (C5.7).
- Meta accepte un Purchase puis l'écriture « envoyé » échoue 5 fois : statut « Échec » alors
  que Meta l'a reçu (dédoublonné par `event_id`, à vérifier par C5.14).
- Une relance perdue puis réinjectée après ses 3 reports (~6 min) peut doubler la demande.
- « Injoignable » peut renvoyer un 409 si le motif change entre ses deux écritures : rien
  n'est écrit, il suffit de recliquer.
- Message WhatsApp reçu avant l'arrivée de la commande : traité comme un message libre (la
  demande à T+5 sert de filet).
- Après un arrêt de plusieurs jours, la relance automatique reprend les commandes restées
  « en attente » quel que soit leur âge : l'étape 2 de la bascule le vérifie.
- Axiom injoignable ou qui refuse : les logs restent dans `docker logs`, mais une partie ne
  part pas vers Axiom. Chaque lot a 3 essais (quelques dizaines de secondes), puis il est
  abandonné ; un refus définitif (jeton, dataset, limite d'ingestion 430) l'abandonne aussitôt ;
  au-delà de 5 000 lignes en attente, les plus anciennes sont retirées.
