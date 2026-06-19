# Plan MVP: Shopify WhatsApp & SMS Notification Service

## Summary
Construire un MVP backend deployable qui reçoit les webhooks `orders/create` Shopify, valide leur signature HMAC, normalise les numéros sénégalais, envoie un template WhatsApp avec bouton Confirmer via Meta Cloud API, bascule vers SMS Termii en cas d’échec WhatsApp, trace tout dans MongoDB Atlas, reçoit les réponses WhatsApp des clients, et expose une API dashboard sécurisée pour lecture, retry, relance et confirmation manuelle.

Base actuelle: starter Express/TypeScript/MongoDB avec auth, health, Swagger et Pino. Le projet compile déjà avec `tsc --noEmit`.

Déploiement cible MVP: Docker Compose pour orchestrer l’API Node.js et Redis. MongoDB ne sera pas conteneurisé dans ce projet: l’application utilisera directement MongoDB Atlas via `MONGODB_URI`.

## Key Changes

### Configuration & sécurité
- Étendre `env.config.ts` avec:
  - `JWT_SECRET`
  - `SHOPIFY_WEBHOOK_SECRET`
  - `SHOPIFY_SHOP_DOMAIN` optionnel
  - `META_WHATSAPP_ACCESS_TOKEN`
  - `META_WHATSAPP_APP_SECRET`
  - `META_WHATSAPP_PHONE_NUMBER_ID`
  - `META_WHATSAPP_BUSINESS_ACCOUNT_ID`
  - `META_WHATSAPP_TEMPLATE_NAME`
  - `META_WHATSAPP_CONFIRMED_TEMPLATE_NAME`
  - `META_WHATSAPP_CANCELLED_TEMPLATE_NAME`
  - `META_WHATSAPP_TEMPLATE_LANGUAGE=fr`
  - `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  - `TERMII_API_KEY`
  - `TERMII_SENDER_ID`
  - `MONGODB_URI` pointant vers MongoDB Atlas
  - `REDIS_URL`
  - `CONFIRMATION_FIRST_REMINDER_HOURS`
  - `CONFIRMATION_SECOND_REMINDER_HOURS`
  - `CONFIRMATION_EXPIRE_HOURS`
  - `CONFIRMATION_MAX_REMINDERS`
  - `CONFIRMATION_REMINDER_COOLDOWN_MINUTES`
  - `CONFIRMATION_SWEEP_INTERVAL_MINUTES`
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
Notes importantes:
- Ne pas réutiliser le même champ pour deux sens métier différents. L’annulation Shopify et l’annulation du workflow de confirmation client/admin doivent rester séparées:
  - Shopify: `shopifyCancelledAt`, `shopifyCancelReason`
  - Workflow confirmation: `confirmationCancelledAt`, `confirmationCancelReason`
- Les champs de confirmation client listés ci-dessous font partie du nouveau workflow WhatsApp entrant; ils ne sont pas encore tous présents dans les modèles actuellement implémentés.

- Ajouter `Order`:
  - `shopifyOrderId`, `shopifyOrderName`
  - `customerId`
  - `customerName`, `customerPhoneRaw`, `customerPhoneE164`, `customerEmail`
  - `lineItems` avec produit, variante, quantité, prix, SKU, vendor
  - `totalPrice`, `subtotalPrice`, `currentTotalPrice`, `totalOutstanding`, `totalDiscounts`, `currency`
  - `shippingPrice`, `shippingTitle`
  - `paymentGatewayNames`, `isCashOnDelivery`
  - `tags`, `sourceName`, `orderStatusUrl`, `noteAttributes`
  - `isTest`, `shopifyCancelledAt`, `shopifyCancelReason`
  - `financialStatus`, `fulfillmentStatus`
  - `notificationStatus`: `pending | sent | failed | skipped | partially_sent`
  - `customerConfirmationStatus`: `pending | confirmed | needs_attention | expired | cancelled | sms_only`
  - `confirmationSource`: `whatsapp_button | admin`
  - `confirmedAt`, `confirmationCancelledAt`, `expiredAt`
  - `confirmationCancelReason`
  - `lastCustomerMessageAt`, `lastCustomerMessageText`
  - `reminderCount`, `lastReminderAt`, `lastReminderSource`
  - `confirmationPayload`, `attentionReason`, `needsHelpdeskAttention`
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
  - `status`: `queued | sending | sent | delivered | read | failed`
  - `templateName`
  - `templatePurpose`: `order_confirmation_request | order_confirmed | reminder | sms_fallback`
  - payload bouton envoyé, ex: `CONFIRM_ORDER:{orderId}`
  - `attemptCount`
  - `providerMessageId`
  - `providerResponse`
  - `errorCode`, `errorMessage`
  - `fallbackOfMessageId`
  - timestamps
- Ajouter éventuellement `WebhookEvent` pour audit/idempotence:
  - `webhookId`, `topic`, `shopDomain`, `status`, `payloadHash`, `orderId`.
- Ajouter `InboundWhatsAppEvent` pour tracer les réponses clients:
  - `messageId`, `waMessageId`, `from`, `type`, `text`
  - `buttonPayload`, `buttonText`
  - `orderId`, `rawPayload`
  - `processedStatus`: `processed | ignored | needs_attention | failed`

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
- Jobs principaux:
  - `sendOrderConfirmation`
  - `sendOrderConfirmed`
  - `sendConfirmationReminder`
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
  - utiliser le template initial configurable par env pour demander la confirmation client
  - langue par défaut `fr`
  - variables: greeting, name, order number, item, amount, quantity, address, shipping note, payment method
  - ajouter au bouton Quick Reply un payload technique dynamique: `CONFIRM_ORDER:{orderId}`
  - ne jamais confirmer automatiquement une commande sans payload fiable
  - envoyer le template `order_confirmed` après confirmation client ou admin
  - envoyer le template `order_canceled_by_admin` après annulation admin si `META_WHATSAPP_CANCELLED_TEMPLATE_NAME` est configuré
  - le fallback SMS générique ne s'applique qu'à l'échec définitif du template initial de demande de confirmation, jamais aux templates `order_confirmed`, annulation ou relance.
- SMS:
  - texte français simple configurable dans le service:
    - confirmation commande
    - numéro commande
    - montant
    - signature boutique
- Si WhatsApp échoue et que le fallback SMS part, passer la commande en `customerConfirmationStatus=sms_only`, car le SMS MVP informe le client mais ne permet pas de confirmation automatique.
- Ne pas bloquer le webhook si Meta/Termii est indisponible: l’échec est traité par job + retry.

### Webhook WhatsApp entrant & confirmation client
- Ajouter:
  - `GET /api/webhooks/whatsapp` pour la vérification Meta avec `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  - `POST /api/webhooks/whatsapp` pour recevoir les messages entrants, clics bouton et statuts Meta
- Protéger `POST /api/webhooks/whatsapp` avec la signature Meta `X-Hub-Signature-256` et `META_WHATSAPP_APP_SECRET`.
- Quand le client clique sur le bouton Confirmer:
  - lire `button.payload`
  - parser `CONFIRM_ORDER:{orderId}`
  - retrouver la commande
  - si la commande est encore confirmable, passer `customerConfirmationStatus=confirmed`
  - définir `confirmedAt` et `confirmationSource=whatsapp_button`
  - enqueue le job `sendOrderConfirmed`
- Si le client répond un message libre:
  - stocker le message
  - passer la commande en `needs_attention`
  - définir `needsHelpdeskAttention=true`
  - ne pas confirmer automatiquement
- Si le client confirme après expiration ou annulation:
  - ne pas confirmer automatiquement
  - passer ou garder la commande en `needs_attention`
  - définir `needsHelpdeskAttention=true`
- Les statuts Meta `sent/delivered/read/failed` mettent à jour les `Message` correspondants quand le `wamid` est connu.

### Relances & prise en charge admin
- Relance automatique ou manuelle:
  - commande `pending`
  - première relance après 24h sans confirmation
  - deuxième relance après 48h sans confirmation
  - après 2 relances sans réponse, passer `customerConfirmationStatus=expired`
- Empêcher les doublons de relance avec `lastReminderAt`, `reminderCount` et `lastReminderSource`.
- Si `needs_attention`, l’admin décide manuellement:
  - confirmer: passer `confirmed`, `confirmationSource=admin`, puis envoyer `order_confirmed`
  - annuler: passer `cancelled`, avec une raison obligatoire, puis envoyer le template d'annulation si configuré
- Planifier un job BullMQ repeatable `confirmationSweep` pour déclencher les relances automatiques et l'expiration.
- Cas à traiter manuellement:
  - numéro invalide ou absent
  - SMS fallback uniquement
  - réponse libre du client
  - confirmation tardive après expiration
  - demande de modification après confirmation

### API Dashboard / Helpdesk MVP
- Protéger avec JWT.
- Ajouter:
  - `GET /api/customers`
  - `GET /api/orders`
  - `GET /api/orders/:id`
  - `GET /api/messages`
  - `GET /api/messages/:id`
  - `POST /api/messages/:id/retry`
  - `POST /api/orders/:id/confirm`
  - `POST /api/orders/:id/cancel`
  - `POST /api/orders/:id/remind`
  - `GET /api/whatsapp/templates`
- Filtres MVP:
  - clients: `search`, `phone`, `email`, pagination
  - `status`
  - `customerConfirmationStatus`
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
  - WhatsApp Webhooks
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
  - template WhatsApp envoyé avec payload bouton `CONFIRM_ORDER:{orderId}`
  - webhook WhatsApp bouton Confirmer passe la commande en `confirmed`
  - webhook WhatsApp texte libre passe la commande en `needs_attention`
  - confirmation admin déclenche le template `order_confirmed`
  - relances incrémentent `reminderCount` et expirent après 2 relances sans réponse
  - échec WhatsApp déclenche fallback SMS
  - fallback SMS passe la confirmation client en `sms_only`
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
- Le bouton du template initial reste un Quick Reply avec payload dynamique `CONFIRM_ORDER:{orderId}` ajouté lors de l’envoi Cloud API.
- Le template `order_confirmed` est envoyé uniquement après confirmation client ou admin.
- Toute réponse libre du client est traitée comme `needs_attention` pour intervention admin.

## Perspectives
- Ajouter d’autres webhooks Shopify: `orders/updated`, `fulfillments/create`, `refunds/create`.
- Ajouter templates multiples: confirmation, paiement reçu, expédition, livraison, relance.
- Ajouter conversation/helpdesk réel: notes internes, assignation, tags, historique client.
- Ajouter analytics: taux succès WhatsApp/SMS, coût provider, échecs par opérateur.
- Ajouter multi-boutique Shopify si plusieurs shops doivent utiliser le même backend.
- Ajouter rate limiting, audit admin, refresh tokens et rôles plus stricts.
- Ajouter healthchecks Redis/API, monitoring, alerting et backups opérationnels Atlas/Redis.
