# Plan MVP: Shopify WhatsApp & SMS Notification Service

## Summary
Construire un MVP backend deployable qui reçoit les webhooks `orders/create` Shopify, valide leur signature HMAC, normalise les numéros sénégalais, envoie une confirmation WhatsApp via Meta Cloud API, bascule vers SMS Termii en cas d’échec, trace tout dans MongoDB Atlas, et expose une API dashboard sécurisée pour lecture + retry.

Base actuelle: starter Express/TypeScript/MongoDB avec auth, health, Swagger et Pino. Le projet compile déjà avec `tsc --noEmit`.

Déploiement cible MVP: Docker Compose pour orchestrer l’API Node.js et Redis. MongoDB ne sera pas conteneurisé dans ce projet: l’application utilisera directement MongoDB Atlas via `MONGODB_URI`.

## Key Changes

### Configuration & sécurité
- Étendre `env.config.ts` avec:
  - `JWT_SECRET`
  - `SHOPIFY_WEBHOOK_SECRET`
  - `SHOPIFY_SHOP_DOMAIN` optionnel
  - `META_WHATSAPP_ACCESS_TOKEN`
  - `META_WHATSAPP_PHONE_NUMBER_ID`
  - `META_WHATSAPP_TEMPLATE_NAME`
  - `META_WHATSAPP_TEMPLATE_LANGUAGE=fr`
  - `TERMII_API_KEY`
  - `TERMII_SENDER_ID`
  - `MONGODB_URI` pointant vers MongoDB Atlas
  - `REDIS_URL`
- Mettre à jour `.env.example` avec toutes les variables attendues.
- Ne pas ajouter de service MongoDB dans Docker Compose: Atlas est la source de données unique.
- Remplacer le secret JWT hardcodé dans `auth.controller.ts`.
- Ajouter un middleware `requireAuth` pour protéger les endpoints dashboard/retry.
- Garder `/api/webhooks/shopify/orders-create` public mais protégé par HMAC Shopify.

### Webhook Shopify
- Ajouter une route:
  - `POST /api/webhooks/shopify/orders-create`
- Valider `X-Shopify-Hmac-Sha256` avec le raw body et `SHOPIFY_WEBHOOK_SECRET`.
- Répondre rapidement `200/202` après validation et persistance initiale, sans attendre l’envoi des messages.
- Gérer l’idempotence avec `X-Shopify-Webhook-Id` et/ou `shopifyOrderId` pour éviter les doublons.
- Supporter le payload Shopify direct et les payloads de test locaux enveloppés dans `{ payload: ... }`.
- Extraire les champs utiles au MVP:
  - order id, order name, customer name, phone, email
  - total, subtotal, total restant à collecter, frais de livraison, devise
  - financial status, fulfillment status
  - produits commandés (`line_items`)
  - mode de paiement, notamment Cash on Delivery
  - tags, source, URL de statut commande
  - champs Easysell dans `note_attributes`: `Nom complet`, `Téléphone`, `Adresse`, `Région`, `country`, `full_url`.
- Ne pas enqueue de notification pour les commandes `test`, annulées (`cancelled_at`) ou `financial_status=voided`; les persister quand même avec statut `skipped`.
- Ajouter des logs Pino structurés à chaque étape importante: réception webhook, idempotence, extraction client/commande, création client, création commande, création produit, audit webhook, message, enqueue ou skip.

### Données MongoDB
- Ajouter `Order`:
  - `shopifyOrderId`, `shopifyOrderName`
  - `customerId`
  - `customerName`, `customerPhoneRaw`, `customerPhoneE164`, `customerEmail`
  - `lineItems` avec produit, variante, quantité, prix, SKU, vendor
  - `totalPrice`, `subtotalPrice`, `currentTotalPrice`, `totalOutstanding`, `totalDiscounts`, `currency`
  - `shippingPrice`, `shippingTitle`
  - `paymentGatewayNames`, `isCashOnDelivery`
  - `tags`, `sourceName`, `orderStatusUrl`, `noteAttributes`
  - `isTest`, `cancelledAt`, `cancelReason`
  - `financialStatus`, `fulfillmentStatus`
  - `notificationStatus`: `pending | sent | failed | skipped | partially_sent`
  - timestamps
- Ajouter `Customer`:
  - `shopifyCustomerId`, `shopifyCustomerGraphqlId`
  - `fullName`, `firstName`, `lastName`
  - `phoneRaw`, `phoneE164`, `email`
  - adresse, ville/région/pays
  - `orderCount`, `lastOrderId`, `lastOrderName`, `lastOrderAt`
- Ajouter `Product` pour préparer le futur module stock:
  - `shopifyProductId`, `title`, `vendor`, `productExists`
  - variantes avec `shopifyVariantId`, `title`, `sku`, `lastKnownPrice`, `inventoryManagement`
  - `lastOrderId`, `lastOrderName`, `lastSeenAt`, `totalOrderedQuantity`
  - champs stock futurs: `stockTrackingEnabled`, `stockQuantity`, `lowStockThreshold`
- Ajouter `Message`:
  - `orderId`
  - `channel`: `whatsapp | sms`
  - `provider`: `meta | termii`
  - `status`: `queued | sending | sent | failed`
  - `templateName`
  - `attemptCount`
  - `providerMessageId`
  - `providerResponse`
  - `errorCode`, `errorMessage`
  - `fallbackOfMessageId`
  - timestamps
- Ajouter éventuellement `WebhookEvent` pour audit/idempotence:
  - `webhookId`, `topic`, `shopDomain`, `status`, `payloadHash`, `orderId`.

### Normalisation téléphone Sénégal
- Créer un service dédié qui accepte:
  - `77XXXXXXX`, `78XXXXXXX`, `76XXXXXXX`, `70XXXXXXX`, `75XXXXXXX`
  - `22177XXXXXXX`
  - `+22177XXXXXXX`
  - formats avec espaces, tirets, parenthèses
- Sortie canonique: `+221XXXXXXXXX`.
- Si le numéro est invalide, ne pas envoyer de message, marquer la commande/message comme failed avec raison claire.

### Queue BullMQ + Redis
- Ajouter BullMQ + Redis pour traiter les notifications après ack webhook.
- Redis tourne en container Docker Compose, sur un réseau privé, avec volume persistant et mot de passe.
- Créer une queue `notifications`.
- Job principal: `sendOrderConfirmation`.
- Backoff/retry:
  - 3 tentatives pour WhatsApp Meta.
  - Si WhatsApp échoue définitivement, créer puis envoyer un SMS Termii.
  - 2 à 3 tentatives SMS.
- Le worker démarre avec le serveur après connexion MongoDB/Redis.
- Logs Pino structurés par `orderId`, `messageId`, `provider`, `attempt`.

### Providers messaging
- Créer une interface commune:
  - `sendOrderConfirmation(input): Promise<ProviderResult>`
- Implémenter:
  - `MetaWhatsAppProvider`
  - `TermiiSmsProvider`
- WhatsApp:
  - utiliser un template Meta configurable par env
  - langue par défaut `fr`
  - variables: nom client, numéro commande, total, devise
- SMS:
  - texte français simple configurable dans le service:
    - confirmation commande
    - numéro commande
    - montant
    - signature boutique
- Ne pas bloquer le webhook si Meta/Termii est indisponible: l’échec est traité par job + retry.

### API Dashboard / Helpdesk MVP
- Protéger avec JWT.
- Ajouter:
  - `GET /api/customers`
  - `GET /api/orders`
  - `GET /api/orders/:id`
  - `GET /api/messages`
  - `GET /api/messages/:id`
  - `POST /api/messages/:id/retry`
- Filtres MVP:
  - clients: `search`, `phone`, `email`, pagination
  - `status`
  - `channel`
  - `provider`
  - `orderName`
  - `phone`
  - pagination simple `page` / `limit`
- Retry:
  - autorisé seulement sur message `failed`
  - recrée un job BullMQ
  - incrémente/trace une nouvelle tentative sans effacer l’historique.

### Swagger & structure
- Mettre à jour Swagger:
  - Health
  - Auth
  - Shopify Webhooks
  - Orders
  - Messages
- Garder une structure simple:
  - `controllers`
  - `routes`
  - `models`
  - `services`
  - `providers`
  - `queues`
  - `middlewares`
- Corriger les incohérences mineures existantes si rencontrées, notamment les types Express obsolètes ou imports inutiles.

### Déploiement Docker Compose
- Ajouter un `Dockerfile` dev minimal pour l’API Node.js.
- Ajouter un `docker-compose.yml` et un `docker-compose.dev.yml` orientés dev simple avec:
  - service `api`
  - service `redis`
  - volume persistant Redis
  - réseau privé Docker
- En dev, bind-mount tout le projet dans `/app` et utiliser les `node_modules` locaux pour que `npm install` local + `docker compose restart api` suffise sans rebuild.
- Ne pas inclure MongoDB dans Compose: `MONGODB_URI` doit pointer vers Atlas.
- En dev, exposer seulement l’API sur le port local utilisé par ngrok.
- En prod, exposer l’API via reverse proxy/Coolify; garder Redis non public.
- Render reste une alternative possible, mais nécessiterait une adaptation en services Render/`render.yaml` plutôt qu’un déploiement direct du Compose tel quel.

## Test Plan
- Tests automatisés avec Jest/Supertest, mais priorité au MVP fonctionnel.
- Tests minimum utiles:
  - normalisation téléphone Sénégal valide/invalide
  - validation HMAC Shopify correcte/incorrecte
  - webhook crée une commande et enqueue un job
  - webhook dupliqué ne crée pas deux commandes/messages
  - provider WhatsApp mocké en succès
  - échec WhatsApp déclenche fallback SMS
  - `POST /api/messages/:id/retry` refuse les messages non failed
  - endpoints dashboard refusent les requêtes sans JWT
- Vérifications manuelles:
  - `npm run tsc -- --noEmit`
  - `npm run dev` ou `docker compose up`
  - appel webhook local avec payload Shopify simulé
  - consultation Swagger `/api/docs`
  - lecture commandes/messages via API.

## Assumptions
- Langue client MVP: français.
- Marché cible initial: Sénégal, format final téléphone `+221XXXXXXXXX`.
- Provider initial: Meta WhatsApp Cloud API + Termii SMS.
- Traitement webhook: ack rapide + job BullMQ/Redis.
- MongoDB est fourni par Atlas; aucune configuration MongoDB locale ou container MongoDB n’est prévue pour le MVP.
- Docker Compose orchestre l’API et Redis; Redis reste privé au réseau Docker.
- Déploiement recommandé: VPS + Coolify + Docker Compose + MongoDB Atlas. Alternative Render possible avec adaptation.
- Auth: durcissement minimal, pas refonte complète.
- Frontend non inclus dans ce plan; l’API sera prête pour un dashboard futur.
- Les templates WhatsApp devront être créés/validés côté Meta avant usage production.

## Perspectives
- Ajouter d’autres webhooks Shopify: `orders/updated`, `fulfillments/create`, `refunds/create`.
- Ajouter templates multiples: confirmation, paiement reçu, expédition, livraison, relance.
- Ajouter conversation/helpdesk réel: notes internes, assignation, tags, historique client.
- Ajouter analytics: taux succès WhatsApp/SMS, coût provider, échecs par opérateur.
- Ajouter multi-boutique Shopify si plusieurs shops doivent utiliser le même backend.
- Ajouter rate limiting, audit admin, refresh tokens et rôles plus stricts.
- Ajouter healthchecks Redis/API, monitoring, alerting et backups opérationnels Atlas/Redis.
