# Chantier 5 — Meta CAPI et anti-fraude WhatsApp : statut au 01/11/2026

Le code du Chantier 5 est fusionné dans `dev` (back et front). La CAPI reste coupée
(`META_CAPI_ENABLED=false`) jusqu'à la bascule, qui est une suite d'actions humaines
décrite plus bas. Le détail de chaque tâche est sur sa carte Trello (tableau ecom_helper),
qui fait foi.

## Ce que fait le chantier

Les fausses commandes COD faussent l'optimisation Facebook. Désormais :

- **Une vente n'est déclarée à Meta (« Purchase ») qu'une fois confirmée**, par le serveur
  seul, avec un secours à la livraison. Elle part une seule fois (`event_id` stable), en
  euros (parité 655,957), sur le prix des articles après remise et sans livraison, avec les
  données client hachées et les signaux du navigateur capturés par le thème.
- **Le client confirme en un clic sur WhatsApp** : message pré-rempli par EasySell, reconnu
  seulement s'il correspond au modèle configuré et vient du numéro de la commande. Sinon, la
  commande part en « Numéro différent » et ne se confirme plus que par un appel d'agent,
  verrou côté serveur compris.
- **La première demande WhatsApp part à T+5 min**, et seulement si le client n'a pas déjà
  confirmé. Une commande confirmée n'est jamais redemandée ni rétrogradée.

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
| Tests C5 | Parcours de bout en bout et tests manquants | #32 | — |
| Divers | Suppression du script de rattrapage, tests des préfixes 71/72/79 | #23, #27 | — |

Vérification à la clôture : `npm run build` OK et `npm test` 40 suites / 803 tests verts sur
`dev` (7eaf3a0) ; build du front OK sur `dev` (8e4bf5c). Chaque PR a été relue par un autre
modèle que son auteur, puis le chantier entier par deux chasses aux bloquants (4 puis 2
relecteurs, sur une vraie API avec bases jetables) : aucun bloquant restant.

## Bascule : actions humaines, dans l'ordre

1. **Avant** : révoquer le jeton Meta exposé le 29/10 ; générer le jeton Conversions API
   du dataset (pas le jeton WhatsApp) et noter l'identifiant du dataset.
2. **Front** : déployer `dev` (Netlify) avant le back ou en même temps, et faire recharger
   tous les onglets du helpdesk restés ouverts (un ancien front plante sur un motif inconnu).
3. **`.env` du back** (aucune nouvelle variable obligatoire tant que la CAPI est coupée) :
   - `SESSION_CAPTURE_ALLOWED_ORIGINS=https://<domaine boutique>` (schéma inclus, sans
     chemin, toutes les variantes servies) ;
   - CAPI : `META_CAPI_DATASET_ID`, `META_CAPI_ACCESS_TOKEN`, `META_CAPI_ENABLED=true`
     (`true` / `false` seulement : toute autre valeur empêche l'API de démarrer), et
     `META_CAPI_TEST_EVENT_CODE` pendant la recette ;
   - `PREFILLED_CONFIRMATION_TEMPLATE` : le texte EasySell à l'identique, la variable du
     numéro de commande remplacée par `{{order.number}}`, **entre guillemets**. Ex. EasySell
     « Je confirme ma commande #{n°} » → `"Je confirme ma commande #{{order.number}}"`.
     Ne jamais recopier `#{n°}` ; sans guillemets la valeur est coupée au `#`. Dans les deux
     cas l'API démarre mais la confirmation par message est coupée (voir étape 5).
4. **Déploiement** : contrôle à froid sans afficher de secret,
   `docker compose -f docker-compose.prod.yml config | grep -E 'META_CAPI_ENABLED|PREFILLED_CONFIRMATION_TEMPLATE'`,
   puis `docker compose -f docker-compose.prod.yml up -d --build`. Après toute modification
   du `.env` : `up -d`, jamais `restart`. Dès ce déploiement, plus de demande immédiate (T+5).
5. **Logs** (`docker logs shopify-helper-api`) :
   - « CAPI purchase worker started » et « CAPI purchase sweep scheduled » ;
   - aucun `CapiNotConfigured` (sinon redémarrage en boucle, API entière coupée) ;
   - CAPI activée : « CAPI enabled » avec `"datasetPresent":true` ;
   - « Pre-filled confirmation template loaded … enabled » : comparer son champ `template`
     au texte EasySell ; une ligne « … disabled » signifie que la confirmation par message
     est coupée alors que l'API reste « healthy » ;
   - `docker ps` : « healthy ».
6. **Thème** : `ENDPOINT` de `theme/session.js` vers `https://<API_DOMAIN>/api/session`,
   script avant `</body>` ; vérifier un 204 dans l'onglet Réseau avec un numéro complet de
   9 chiffres (un 403 = origine absente de la variable).
7. **Recette C5.10 / C5.14**, CAPI active et code de test renseigné, Purchase EasySell encore
   actif : confirmer une vraie commande (`isTest:false`) → fiche « Envoyée » et
   `purchase_<id>` ; contrôler dans Test Events et le dédoublonnage par `event_id` ; vider le
   code de test, `up -d`.
8. **Après une conversion « Envoyée » sans code de test**, côté EasySell : couper
   **uniquement** l'événement Purchase ; activer la redirection WhatsApp avec le texte qui a
   servi au modèle ; essai réel immédiat (depuis le numéro de la commande → « Confirmée » ;
   depuis un autre numéro → « Numéro différent » ; « Réponse libre » = texte et modèle
   différents) ; prévenir la personne qui gère les pubs.
9. **À savoir** : les commandes confirmées pendant que la CAPI était coupée restent
   « Ignorée » ; celles créées avant la bascule puis confirmées ou livrées après auront deux
   Purchase (accepté le 30/10).

## Points ouverts

**À trancher par l'humain** (relevés par la relecture de C5.18, antérieurs au chantier) :

- Un message WhatsApp accepté par Meta puis déclaré « échoué » par le webhook (ex. 131026)
  ne déclenche jamais de SMS de secours ; si c'était une relance, la colonne « Notification »
  reste « Envoyée » et bloque la demande suivante.
- L'appel à Meta pour WhatsApp (`metaWhatsApp.provider.ts`) n'a pas de délai maximal : un
  appel bloqué fige toute la file d'envoi. Recommandation : un délai de 10 s, comme la CAPI.

**Actions humaines** : C5.9 (configuration EasySell), C5.10 (recette), C5.14 (vérifier que
Meta dédoublonne un même `event_id`).

**Cartes reportées** : C5.7 (rejouer un envoi en échec ou ignoré), C5.21 (actions d'agent
sans attendre Redis), C5.22 (modèle du message pré-rempli en base), renvoi avec choix du
modèle, masquage des téléphones dans les logs, commandes Shopify test / voided relancées,
« Petits défauts », répercuter les actions du helpdesk dans Shopify (Brainstorming).

## Limites connues, acceptées

- Une commande annulée ou rouverte, puis reconfirmée ou livrée **après** le réessai de
  l'envoi Meta, reste « Ignorée » (rattrapage prévu par C5.7).
- Meta accepte un Purchase puis l'écriture « envoyé » échoue 5 fois : statut « Échec » alors
  que Meta l'a reçu (dédoublonné par `event_id`, à vérifier par C5.14).
- Une relance perdue puis réinjectée après ses 3 reports (~6 min) peut doubler la demande.
- « Injoignable » peut renvoyer un 409 si le motif change entre ses deux écritures : rien
  n'est écrit, il suffit de recliquer.
- Message WhatsApp reçu avant l'arrivée de la commande : traité comme un message libre (la
  demande à T+5 sert de filet).
