# Plan D’implémentation Granulaire MVP

## Objectif
Livrer un backend MVP deployable qui reçoit `orders/create` Shopify, valide le webhook, crée une commande, envoie un template WhatsApp Meta avec bouton Confirmer via job BullMQ, bascule vers SMS Termii si WhatsApp échoue, reçoit les réponses WhatsApp clients, trace tout dans MongoDB Atlas, puis expose une API dashboard protégée pour lecture, retry, relance et confirmation manuelle.

Le déploiement cible du MVP utilise Docker Compose pour l’API Node.js et Redis. MongoDB n’est pas déployé en container: `MONGODB_URI` pointe directement vers MongoDB Atlas pour éviter de perdre du temps sur l’administration MongoDB locale/prod.

## Étape 0: Stabilisation Technique
- Ajouter les dépendances nécessaires:
  - `bullmq`
  - `ioredis`
  - `axios`
  - `jest`, `ts-jest`, `supertest`, `@types/jest`, `@types/supertest` si tests activés.
- Créer la configuration Jest minimale, sans viser une couverture exhaustive.
- Vérifier que `npm run tsc -- --noEmit` reste vert après chaque gros bloc.
- Nettoyer les incohérences existantes si elles bloquent le build ou les nouveaux types.
- Préparer la base Docker:
  - `Dockerfile` API Node.js minimal pour le dev
  - `.dockerignore`
  - `docker-compose.yml` avec `api` + `redis`
  - `docker-compose.dev.yml` avec bind mount du projet local
  - pas de service MongoDB dans Compose.
- En dev, garder `node_modules` en local et bind-mount tout le projet dans `/app`.
- Après un `npm install` local, un simple `docker compose restart api` ou `docker compose down && docker compose up` doit suffire, sans rebuild.

Critère d’acceptation:
- Le projet démarre toujours avec `npm run dev`.
- Le projet peut aussi démarrer avec `docker compose up`.
- Le projet compile sans erreur TypeScript.

## Étape 1: Configuration & Sécurité
- Étendre `src/utilities/config/env.config.ts` avec:
  - `jwtSecret`
  - `shopify.webhookSecret`
  - `shopify.shopDomain`
  - `metaWhatsApp.accessToken`
  - `metaWhatsApp.phoneNumberId`
  - `metaWhatsApp.templateName`
  - `metaWhatsApp.templateLanguage`
  - `termii.apiKey`
  - `termii.senderId`
  - `mongodbUri` connecté à MongoDB Atlas
  - `redisUrl`
- Mettre à jour `.env.example`.
- Documenter que `MONGODB_URI` doit être une URI Atlas, par exemple `mongodb+srv://...`.
- Utiliser `REDIS_URL=redis://:<password>@redis:6379` dans Docker Compose.
- Remplacer `RANDOM_TOKEN_SECRET` dans `auth.controller.ts` par `config.jwtSecret`.
- Ajouter un middleware `requireAuth`.
- Protéger les futures routes dashboard avec ce middleware.

Critère d’acceptation:
- Login génère un JWT avec le secret d’environnement.
- Une route protégée rejette les requêtes sans `Authorization: Bearer <token>`.
- L’application se connecte à Atlas sans dépendre d’un container MongoDB local.

## Étape 2: Modèles MongoDB MVP
Notes importantes:
- Ne pas mélanger l’annulation Shopify et l’annulation du workflow confirmation. Utiliser des champs séparés:
  - `shopifyCancelledAt`, `shopifyCancelReason`
  - `confirmationCancelledAt`, `confirmationCancelReason`
- Les champs liés à la confirmation client sont planifiés à l’étape 11. Les premiers modèles MVP déjà créés ne les contiennent pas encore tous.

- Créer `Order` avec les champs Shopify utiles:
  - identifiants Shopify
  - référence `customerId`
  - client
  - téléphone brut et normalisé
  - produits commandés (`lineItems`)
  - total/devise
  - subtotal, current total, montant restant à collecter, discounts
  - frais/titre de livraison
  - gateways de paiement et `isCashOnDelivery`
  - tags, source, URL statut commande
  - note attributes Easysell
  - indicateurs `isTest`, `shopifyCancelledAt`, `shopifyCancelReason`
  - statuts Shopify
  - `notificationStatus`, avec `skipped` pour les commandes persistées mais non notifiées
- Créer `Customer` pour avoir une liste clients exploitable:
  - identifiants Shopify
  - nom, téléphone brut/normalisé, email
  - adresse, ville/région/pays
  - nombre de commandes et dernière commande
- Créer `Product` pour préparer le futur module gestion de stock:
  - identifiant produit Shopify
  - titre, vendor, existence Shopify
  - variantes Shopify avec SKU, prix vu, inventory management
  - quantité totale commandée observée
  - champs stock futurs désactivés par défaut
- Créer `Message` avec:
  - commande liée
  - canal `whatsapp | sms`
  - provider `meta | termii`
  - statut `queued | sending | sent | failed`
  - tentative, réponse provider, erreur, fallback éventuel.
- Créer `WebhookEvent` pour idempotence/audit:
  - `webhookId`
  - `topic`
  - `shopDomain`
  - `payloadHash`
  - `status`
  - `orderId`
- Ajouter les index:
  - unique sur `shopifyOrderId`
  - unique/sparse sur `webhookId`
  - index sur statuts, téléphone, date.

Critère d’acceptation:
- Une commande Shopify ne peut pas être créée deux fois.
- Un webhook déjà reçu est reconnu comme doublon.
- Un client peut être créé/mis à jour depuis une commande.
- Un produit et ses variantes peuvent être créés/mis à jour depuis `line_items`.

## Étape 3: Normalisation Téléphone Sénégal
- Créer un service `phoneNormalization.service.ts`.
- Accepter:
  - `77XXXXXXX`, `78XXXXXXX`, `76XXXXXXX`, `70XXXXXXX`, `75XXXXXXX`
  - `221XXXXXXXXX`
  - `+221XXXXXXXXX`
  - formats avec espaces/tirets/parenthèses.
- Retourner:
  - `isValid`
  - `raw`
  - `e164`
  - `errorReason` si invalide.
- Ne pas faire d’envoi si le numéro est invalide.

Critère d’acceptation:
- `77 123 45 67` devient `+221771234567`.
- Un numéro non sénégalais ou incomplet est marqué invalide clairement.

## Étape 4: Validation Webhook Shopify
- Configurer Express pour conserver le raw body nécessaire au HMAC sur la route Shopify.
- Créer un middleware `verifyShopifyWebhook`.
- Vérifier `X-Shopify-Hmac-Sha256` avec `SHOPIFY_WEBHOOK_SECRET`.
- Lire aussi:
  - `X-Shopify-Webhook-Id`
  - `X-Shopify-Topic`
  - `X-Shopify-Shop-Domain`
- Rejeter les signatures invalides en `401`.

Critère d’acceptation:
- Un webhook avec HMAC valide passe.
- Un webhook sans HMAC ou avec HMAC invalide est refusé.

## Étape 5: Ingestion Orders/Create
- Ajouter:
  - `POST /api/webhooks/shopify/orders-create`
- Extraire du payload Shopify:
  - `id`
  - `name`
  - payload direct Shopify ou payload local enveloppé dans `{ payload: ... }`
  - `customer.first_name`
  - `customer.last_name`
  - `customer.email`
  - `phone`, `customer.phone`, `shipping_address.phone`, `billing_address.phone`
  - `note_attributes` Easysell (`Nom complet`, `Téléphone`, `Adresse`, `Région`, `country`, `full_url`)
  - `total_price`
  - `subtotal_price`, `current_total_price`, `total_outstanding`, `total_discounts`
  - frais et titre de livraison
  - `currency`
  - `payment_gateway_names`, tags, source, URL statut commande
  - `line_items`
  - `test`, `cancelled_at`, `cancel_reason`
  - `financial_status`
  - `fulfillment_status`
- Choisir le premier téléphone disponible dans l’ordre:
  - `shipping_address.phone`
  - `billing_address.phone`
  - `customer.phone`
  - `phone`
- Créer/mettre à jour `Order`.
- Créer/mettre à jour `Customer`.
- Créer/mettre à jour `Product` et ses variantes depuis les `line_items`, sans encore gérer les décréments de stock.
- Créer `WebhookEvent`.
- Créer un premier `Message` WhatsApp en `queued` si numéro valide.
- Si numéro invalide, marquer `Order.notificationStatus = failed`.
- Si commande test, annulée ou `financial_status=voided`, créer la commande et le message d’audit mais ne pas enqueue; marquer `Order.notificationStatus = skipped`.
- Enqueue le job BullMQ seulement après persistance.
- Répondre vite `202`.
- Ajouter des logs Pino structurés pour suivre tout le flux:
  - réception webhook
  - doublon par `webhookId`
  - doublon par `shopifyOrderId`
  - champs requis manquants
  - extraction client/commande
  - upsert client
  - création commande
  - upsert produits
  - stockage `WebhookEvent`
  - création message
  - enqueue ou skip

Critère d’acceptation:
- Le webhook crée une commande et un message WhatsApp queued.
- Le webhook alimente aussi les clients et produits.
- Le endpoint ne fait pas d’appel Meta/Termii directement.
- Un doublon ne recrée pas de message inutile.
- Une commande test/annulée/voided ne déclenche pas de notification.

## Étape 6: Queue BullMQ + Worker
- Créer une queue `notifications`.
- Créer un worker `notification.worker.ts`.
- Job principal:
  - `sendOrderConfirmation`
- Job data minimale:
  - `orderId`
  - `messageId`
  - `channel`
- Configurer Redis via `REDIS_URL`.
- Faire tourner Redis via Docker Compose:
  - image `redis:7.2-alpine`
  - `appendonly yes`
  - `requirepass`
  - volume `redis_data`
  - aucun port Redis exposé publiquement en prod.
- Démarrer le worker au boot serveur après init config.
- Ajouter retries BullMQ avec backoff exponentiel.

Critère d’acceptation:
- Un webhook ajoute un job.
- Le worker récupère le job.
- Les erreurs provider ne crashent pas le serveur.
- Redis est joignable depuis l’API via le nom de service Docker `redis`.

## Étape 7: Provider Meta WhatsApp
- Créer une interface commune `MessagingProvider`.
- Implémenter `MetaWhatsAppProvider`.
- Envoyer un template Meta:
  - `templateName` depuis env
  - `language` = `fr`
  - variables: greeting, nom client, numéro commande, article, montant, quantité, adresse, note de livraison, mode de paiement.
- Ajouter le payload dynamique au bouton Quick Reply:
  - composant `button`
  - `sub_type=quick_reply`
  - `index=0`
  - payload `CONFIRM_ORDER:{orderId}`
- Stocker ce payload dans le `Message` associé pour audit et debug.
- Sauvegarder:
  - provider response
  - provider message id si disponible
  - statut `sent` ou `failed`.
- Mettre à jour `Order.notificationStatus`.
- Garder la confirmation client en `pending` après envoi WhatsApp réussi.

Critère d’acceptation:
- En succès Meta, le message passe à `sent`.
- La commande passe à `sent`.
- Les réponses Meta sont persistées.
- Le message WhatsApp contient le payload bouton `CONFIRM_ORDER:{orderId}`.
- La commande n’est pas marquée `confirmed` tant que le webhook bouton n’est pas reçu.

## Étape 8: Fallback SMS Termii
- Implémenter `TermiiSmsProvider`.
- Définir un texte SMS français simple:
  - “Bonjour {name}, votre commande {orderName} de {total} {currency} a bien été reçue. Merci.”
- Si WhatsApp échoue définitivement:
  - créer un nouveau `Message` SMS en `queued`
  - lier `fallbackOfMessageId`
  - enqueue ou traiter le SMS via worker.
- Si SMS réussit:
  - commande `partially_sent` ou `sent` selon convention retenue.
  - confirmation client `sms_only`, car le SMS MVP ne confirme pas automatiquement.
- Si SMS échoue:
  - commande `failed`.

Critère d’acceptation:
- Échec WhatsApp déclenche automatiquement SMS.
- L’historique garde les deux messages.
- Le dashboard peut voir la chaîne WhatsApp échoué puis SMS envoyé.
- Une commande passée par SMS fallback apparaît comme confirmation manuelle requise.

## Étape 9: API Dashboard Orders
- Ajouter routes protégées:
  - `GET /api/customers`
  - `GET /api/orders`
  - `GET /api/orders/:id`
- Pour `GET /api/customers`, supporter:
  - pagination `page`, `limit`
  - recherche texte `search`
  - filtre `phone`
  - filtre `email`
- Supporter:
  - pagination `page`, `limit`
  - filtre `status`
  - filtre `customerConfirmationStatus`
  - recherche `orderName`
  - recherche `phone`
- Retourner un format stable:
  - `data`
  - `pagination`
- Inclure un résumé messages dans le détail commande.

Critère d’acceptation:
- Sans JWT: `401`.
- Avec JWT: liste paginée des clients.
- Avec JWT: liste paginée des commandes.
- Le détail montre commande + messages associés.

## Étape 10: API Dashboard Messages + Retry
- Ajouter routes protégées:
  - `GET /api/messages`
  - `GET /api/messages/:id`
  - `POST /api/messages/:id/retry`
- Filtres:
  - `status`
  - `channel`
  - `provider`
- Retry:
  - accepté uniquement si `status = failed`
  - remet le message en `queued`
  - incrémente `attemptCount` ou crée une nouvelle tentative traçable
  - enqueue un nouveau job BullMQ.
- Refuser retry si message `sent`, `queued`, ou `sending`.

Critère d’acceptation:
- Un message failed peut être relancé.
- Un message sent ne peut pas être relancé.
- La relance est visible dans MongoDB.

## Étape 11: Extension Modèles & Config Confirmation Client
- Étendre `env.config.ts` avec les variables nécessaires au nouveau flux:
  - `metaWhatsApp.confirmedTemplateName`
  - `metaWhatsApp.webhookVerifyToken`
- Ajouter dans `.env.example`:
  - `META_WHATSAPP_CONFIRMED_TEMPLATE_NAME=order_confirmed`
  - `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN=...`
- Étendre `Order` avec:
  - `customerConfirmationStatus`: `pending | confirmed | needs_attention | expired | cancelled | sms_only`
  - `confirmationSource`: `whatsapp_button | admin`
  - `confirmedAt`, `confirmationCancelledAt`, `expiredAt`
  - `confirmationCancelReason`
  - `lastCustomerMessageAt`, `lastCustomerMessageText`
  - `reminderCount`, `lastReminderAt`, `lastReminderSource`
  - `confirmationPayload`, `attentionReason`
- Étendre `Message` avec:
  - statuts provider `delivered` et `read`
  - `templatePurpose`: `order_confirmation_request | order_confirmed | reminder | sms_fallback`
  - `buttonPayload`
- Ajouter `InboundWhatsAppEvent`:
  - `waMessageId`, `from`, `type`, `text`
  - `buttonPayload`, `buttonText`
  - `orderId`
  - `rawPayload`
  - `processedStatus`

Critère d’acceptation:
- Le modèle peut distinguer notification envoyée et confirmation client.
- Le payload `CONFIRM_ORDER:{orderId}` est persistable.
- Les réponses WhatsApp entrantes sont auditables sans écraser les messages sortants.

## Étape 12: Webhook WhatsApp Entrant
- Ajouter:
  - `GET /api/webhooks/whatsapp`
  - `POST /api/webhooks/whatsapp`
- `GET`:
  - lire `hub.mode`, `hub.verify_token`, `hub.challenge`
  - comparer avec `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  - retourner le challenge si valide, sinon `403`
- `POST`:
  - recevoir les événements Meta WhatsApp
  - extraire les messages entrants
  - extraire les statuts `sent`, `delivered`, `read`, `failed`
  - stocker le payload brut dans `InboundWhatsAppEvent`
- Pour un clic bouton:
  - lire `button.payload`
  - accepter uniquement le format `CONFIRM_ORDER:{orderId}`
  - retrouver la commande par `orderId`
  - ignorer/idempotenter si déjà `confirmed`
  - passer en `needs_attention` si la commande est `expired` ou `cancelled`
- Pour un message libre:
  - stocker le texte
  - passer la commande en `needs_attention`
  - définir `lastCustomerMessageAt`, `lastCustomerMessageText`, `attentionReason`
- Pour les statuts Meta:
  - retrouver le `Message` par `providerMessageId`/`wamid` si possible
  - mettre à jour `sent`, `delivered`, `read` ou `failed`

Critère d’acceptation:
- Meta peut vérifier le webhook WhatsApp.
- Un clic bouton valide confirme la bonne commande.
- Une réponse libre ne confirme jamais automatiquement.
- Les statuts de livraison Meta enrichissent l’historique message.

## Étape 13: Workflow Confirmation, Relances & Admin
- Créer un service métier `orderConfirmation.service.ts`.
- Confirmation automatique par bouton:
  - `pending -> confirmed`
  - `confirmedAt = now`
  - `confirmationSource = whatsapp_button`
  - enqueue `sendOrderConfirmed`
- Confirmation manuelle admin:
  - endpoint `POST /api/orders/:id/confirm`
  - autorisé depuis `pending`, `needs_attention`, `sms_only`, éventuellement `expired`
  - `confirmationSource = admin`
  - enqueue `sendOrderConfirmed`
- Annulation manuelle admin:
  - endpoint `POST /api/orders/:id/cancel`
  - passer `customerConfirmationStatus=cancelled`
  - définir `confirmationCancelledAt`
  - ne plus relancer automatiquement
- Relance manuelle:
  - endpoint `POST /api/orders/:id/remind`
  - autorisé seulement si `customerConfirmationStatus=pending`
  - incrémenter `reminderCount`
  - définir `lastReminderAt` et `lastReminderSource=admin`
  - enqueue `sendConfirmationReminder`
- Relance automatique:
  - prévoir un job BullMQ repeatable ou une tâche planifiée simple
  - première relance après 24h sans confirmation
  - deuxième relance après 48h sans confirmation
  - après 2 relances sans réponse: `expired`, `expiredAt=now`
- Template `order_confirmed`:
  - envoyé après confirmation bouton ou admin
  - ne pas l’envoyer au moment de création Shopify
  - message attendu: “Commande confirmée, nous préparons votre commande...”

Critère d’acceptation:
- Une confirmation bouton et une confirmation admin déclenchent la même suite métier.
- Une commande `needs_attention` attend une décision admin.
- Une commande `expired` n’est pas confirmée automatiquement par clic tardif.
- Les relances ne partent pas en double.
- `order_confirmed` part seulement après confirmation.

## Étape 14: Swagger MVP
- Mettre à jour Swagger avec:
  - Auth
  - Shopify webhook
  - WhatsApp webhook
  - Orders
  - Messages
- Documenter les headers Shopify nécessaires.
- Documenter le Bearer token pour dashboard.
- Documenter la vérification webhook WhatsApp Meta.
- Documenter les endpoints admin `confirm`, `cancel`, `remind`.
- Ajouter exemples de payload/réponse MVP.

Critère d’acceptation:
- `/api/docs` décrit toutes les routes MVP.
- Les routes dashboard affichent leur besoin d’auth JWT.

## Étape 15: Tests Prioritaires
- Ajouter tests unitaires sur:
  - normalisation téléphone
  - HMAC Shopify
  - parsing payload bouton `CONFIRM_ORDER:{orderId}`
- Ajouter tests API Supertest sur:
  - webhook signature invalide
  - webhook signature valide
  - payload direct Shopify et payload enveloppé `{ payload: ... }`
  - extraction client depuis `note_attributes`
  - skip des commandes test/annulées/voided
  - vérification `GET /api/webhooks/whatsapp`
  - clic bouton WhatsApp confirme la commande
  - message libre WhatsApp passe en `needs_attention`
  - confirmation admin déclenche `order_confirmed`
  - annulation admin passe en `cancelled`
  - relance admin incrémente `reminderCount`
  - endpoints dashboard sans JWT
  - retry message non failed refusé.
- Mocker Meta, Termii, Redis si nécessaire pour éviter dépendance externe forte.
- Garder les tests comme filet minimal, pas comme blocage du MVP si une intégration externe manque.

Critère d’acceptation:
- Les tests critiques passent localement.
- `npm run tsc -- --noEmit` passe.

## Étape 16: Docker Compose, Atlas & Vérification Fonctionnelle Locale
- Vérifier que MongoDB Atlas est prêt:
  - cluster créé
  - utilisateur DB créé
  - IP autorisée ou accès réseau configuré
  - `MONGODB_URI` renseigné dans `.env`.
- Lancer Redis et l’API via Docker Compose:
  - `docker compose up --build`
- En alternative dev hors Docker:
  - lancer Redis via Compose
  - lancer l’API avec `npm run dev`
  - garder `MONGODB_URI` vers Atlas.
- Créer un utilisateur via `/api/auth/signup`.
- Se connecter via `/api/auth/login`.
- Envoyer un payload Shopify simulé avec HMAC valide.
- Vérifier dans MongoDB:
  - `WebhookEvent`
  - `Order`
  - `Message`
- Vérifier logs worker.
- Tester lecture dashboard avec Bearer token.
- Tester retry sur message failed.
- Tester webhook WhatsApp bouton avec payload `CONFIRM_ORDER:{orderId}`.
- Tester webhook WhatsApp message libre.
- Tester confirmation admin et envoi du template `order_confirmed`.

Critère d’acceptation:
- Le flux complet webhook -> queue -> WhatsApp ou fallback SMS -> tracking fonctionne.
- Aucune étape ne nécessite un MongoDB local.

## Étape 17: Préparation Docker Compose MVP
- Créer un `docker-compose.yml` minimal:
  - `api`: build local, `env_file: .env`, port API exposé.
  - `redis`: `redis:7.2-alpine`, mot de passe, AOF, volume persistant.
  - réseau Docker privé par défaut.
- Créer un `docker-compose.dev.yml` avec:
  - bind mount `.:/app`
  - pas de volume anonyme sur `node_modules`
  - commande `npm run live-dev`
  - dépendances installées localement visibles dans le conteneur.
- Config dev/ngrok:
  - exposer seulement le port API, par exemple `3600:3600`.
  - `API_ENDPOINT=https://<fixed-domain-ngrok>`.
  - Shopify pointe vers `https://<fixed-domain-ngrok>/api/webhooks/shopify/orders-create`.
- Config prod recommandée:
  - VPS + Coolify + Docker Compose.
  - MongoDB Atlas externe.
  - Redis privé au réseau Docker.
  - API exposée via proxy HTTPS Coolify.
- Render:
  - possible comme alternative.
  - nécessite une adaptation en services Render/`render.yaml`.
  - ne doit pas être considéré comme cible principale pour déployer le `docker-compose.yml` tel quel.

Critère d’acceptation:
- `docker compose up --build` lance l’API et Redis.
- Redis n’est pas exposé publiquement.
- Atlas est la seule base MongoDB utilisée.

## Étape 18: Préparation Déploiement MVP
- Documenter les variables d’environnement obligatoires.
- Ajouter une section README “Run local”.
- Ajouter une section README “Run with Docker Compose”.
- Ajouter une section README “MongoDB Atlas setup”.
- Ajouter une section README “Webhook Shopify setup”.
- Ajouter une section README “Meta WhatsApp template”.
- Ajouter une section README “WhatsApp inbound webhook setup”.
- Ajouter une section README “Confirmation workflow”.
- Ajouter une section README “Redis required”.
- Ajouter une section README “Deployment target: VPS + Coolify”.
- Vérifier que l’app fail clairement si une variable critique manque en production.
- Garder les secrets hors repo.

Critère d’acceptation:
- Un déploiement peut être configuré sans lire le code.
- Les prérequis Atlas/Redis/providers sont explicites.

## Ordre Recommandé De Livraison
1. Config/auth/env.
2. Modèles MongoDB.
3. Normalisation téléphone.
4. HMAC Shopify.
5. Webhook ingestion + idempotence + clients/produits/logs.
6. BullMQ/Redis.
7. Worker.
8. Meta WhatsApp.
9. Termii fallback.
10. API dashboard orders/messages.
11. Retry.
12. Extension modèles/config confirmation client.
13. Webhook WhatsApp entrant.
14. Workflow confirmation, relances et admin.
15. Swagger.
16. Tests ciblés.
17. Docker Compose + Atlas + vérification locale.
18. Documentation déploiement.

## Assumptions
- Le MVP reste backend-only.
- Meta WhatsApp utilise un template déjà validé côté Meta.
- MongoDB est MongoDB Atlas en dev et en prod; aucun MongoDB container/local n’est nécessaire.
- Docker Compose est utilisé pour orchestrer l’API et Redis.
- Redis est disponible via Docker Compose en dev et en production.
- La cible prod recommandée est VPS + Coolify + Docker Compose + Atlas.
- Render reste une alternative possible, mais demande une configuration Render dédiée plutôt qu’un Compose direct.
- Termii est uniquement fallback SMS, pas canal principal.
- Le bouton WhatsApp Confirmer utilise un payload dynamique `CONFIRM_ORDER:{orderId}` ajouté à l’envoi du template via Cloud API.
- Le template `order_confirmed` est envoyé uniquement après confirmation bouton ou confirmation admin.
- Toute réponse libre du client passe en `needs_attention`, jamais en confirmation automatique.
- Le fallback SMS met la commande en `sms_only`, donc confirmation manuelle requise.
- Les tests automatisés sont utiles mais ne doivent pas retarder excessivement un premier MVP fonctionnel.
