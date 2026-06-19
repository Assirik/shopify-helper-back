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
  - `metaWhatsApp.appSecret`
  - `metaWhatsApp.phoneNumberId`
  - `metaWhatsApp.businessAccountId`
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
  - complément prévu à l’étape 16: instantané livraison `deliveryRegion`, `deliveryRegionCode`, `deliveryPreferredMoment`, `deliveryAddress`, GPS, IP et locale client
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
  - complément correctif prévu à l’étape 16: région canonique, moment préféré, adresse réelle de livraison, GPS, `browser_ip`, `customer_locale` et parsing corrigé du nom complet
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
  - `metaWhatsApp.appSecret`
  - `metaWhatsApp.businessAccountId`
  - `metaWhatsApp.cancelledTemplateName`
  - `confirmation.firstReminderHours`
  - `confirmation.secondReminderHours`
  - `confirmation.expireHours`
  - `confirmation.maxReminders`
  - `confirmation.reminderCooldownMinutes`
  - `confirmation.sweepIntervalMinutes`
- Ajouter dans `.env.example`:
  - `META_WHATSAPP_APP_SECRET=...`
  - `META_WHATSAPP_BUSINESS_ACCOUNT_ID=...`
  - `META_WHATSAPP_CONFIRMED_TEMPLATE_NAME=order_confirmed`
  - `META_WHATSAPP_CANCELLED_TEMPLATE_NAME=order_canceled_by_admin`
  - `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN=...`
  - les variables `CONFIRMATION_*`
- Étendre `Order` avec:
  - `customerConfirmationStatus`: `pending | confirmed | needs_attention | expired | cancelled | sms_only`
  - `confirmationSource`: `whatsapp_button | admin`
  - `confirmedAt`, `confirmationCancelledAt`, `expiredAt`
  - `confirmationCancelReason`
  - `lastCustomerMessageAt`, `lastCustomerMessageText`
  - `reminderCount`, `lastReminderAt`, `lastReminderSource`
  - `confirmationPayload`, `attentionReason`
  - `needsHelpdeskAttention`
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
  - vérifier la signature Meta `X-Hub-Signature-256` avec `META_WHATSAPP_APP_SECRET`
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
  - définir `lastCustomerMessageAt`, `lastCustomerMessageText`, `attentionReason`, `needsHelpdeskAttention`
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
  - demander une raison d'annulation obligatoire (`reason`)
  - passer `customerConfirmationStatus=cancelled`
  - définir `confirmationCancelledAt`
  - ne plus relancer automatiquement
  - envoyer le template d'annulation si `META_WHATSAPP_CANCELLED_TEMPLATE_NAME` est configuré
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
- Le fallback SMS générique part seulement après l'échec définitif du template initial `sendOrderConfirmation`.
- Les templates `order_confirmed`, annulation et relance échoués ne déclenchent pas le fallback SMS “commande reçue”.

## Étape 14: Templates WhatsApp Dashboard
- Ajouter une route protégée:
  - `GET /api/whatsapp/templates`
- Utiliser `META_WHATSAPP_BUSINESS_ACCOUNT_ID` pour lister les templates Meta configurés.
- Permettre au dashboard/helpdesk de vérifier les noms, langues, statuts et variables des templates réellement validés chez Meta.

Critère d’acceptation:
- Sans JWT: `401`.
- Avec JWT et configuration Meta complète: la route retourne la liste des templates du WABA.

## Étape 15: Configuration Régionale Shipping Note & Payment Method
- Créer un modèle global `MessageVariableConfig` avec:
  - `shippingNote.dakar`
  - `shippingNote.nonDakar`
  - `paymentMethod.dakar`
  - `paymentMethod.nonDakar`
  - timestamps
  - `updatedBy` pour auditer l’administrateur ayant effectué la dernière modification
- Ajouter un service `messageVariableConfig.service.ts` chargé de:
  - lire la configuration globale
  - appliquer une mise à jour partielle
  - reset une valeur avec `null` ou une chaîne vide
  - normaliser et classifier la région de livraison
  - retourner les deux variables résolues pour une commande
- Définir une classification régionale sûre:
  - reconnaître explicitement `Dakar` et ses alias métier autorisés
  - ne pas utiliser une simple recherche `includes('dakar')`, afin que `Hors Dakar` et `Non Dakar` restent hors Dakar
  - ne pas considérer une région absente comme hors Dakar par défaut
- Sauvegarder la région de livraison sur `Order` lors de l’ingestion Shopify afin que les relances utilisent la région de la commande, même si l’adresse du client change ensuite.
- Ajouter un validateur runtime pour le body de configuration:
  - objet JSON obligatoire
  - seuls `shippingNote` et `paymentMethod` sont acceptés
  - seules les variantes `dakar` et `nonDakar` sont acceptées
  - valeur chaîne, `null` ou champ absent uniquement
  - texte non vide après trim, sauf reset explicite
  - longueur maximale 200 caractères
  - aucun saut de ligne, tabulation ou groupe de plus de 4 espaces
- Ajouter les routes helpdesk:
  - `GET /api/whatsapp/message-config`
  - `PUT /api/whatsapp/message-config`
- Protéger la lecture avec JWT et réserver la modification au rôle `ADMIN`.
- Interdire au signup public de choisir ou injecter un rôle administrateur.
- Dans le worker, résoudre les overrides uniquement pour:
  - `ORDER_CONFIRMATION_REQUEST`
  - `REMINDER`
- Conserver les fallbacks actuels quand une variante n’est pas configurée:
  - `shipping_note = order.shippingTitle || 'Livraison standard'`
  - `payment_method = moyen de paiement réel de la commande`
- Ne pas appliquer un texte COD configuré aux commandes non-COD; conserver leur moyen de paiement réel ou prévoir une règle explicitement compatible.
- Ajouter des tests unitaires et API couvrant:
  - Dakar, Région de Dakar, Hors Dakar, Non Dakar, Thiès et région absente
  - configuration complète et mises à jour partielles
  - reset par `null`/chaîne vide
  - rejet des nombres, tableaux, champs inconnus et variantes inconnues
  - accès USER refusé et ADMIN autorisé
  - résolution worker Dakar/hors Dakar et fallback sans configuration
  - stabilité d’une ancienne commande après changement de région du client

Critère d’acceptation:
- Le helpdesk peut modifier indépendamment les quatre textes régionaux.
- Une commande Dakar et une commande hors Dakar reçoivent chacune les valeurs attendues.
- Une région absente ou ambiguë n’entraîne pas l’envoi d’une mauvaise consigne régionale.
- Les payloads invalides retournent `400` sans erreur serveur.
- Seul un administrateur peut modifier cette configuration globale.
- Les templates confirmé et annulé restent inchangés.

## Étape 16: Enrichissement Ingestion & Robustesse Config Variables
- Appliquer les nouvelles directives détaillées dans [fait-moi-un-plan-concurrent-wind.md](fait-moi-un-plan-concurrent-wind.md):
  - contexte, décisions retenues et ordre interne: lignes 3 à 20, à l’exception de la décision JWT simple de la ligne 13
  - fichiers concernés: lignes 24 à 31
  - enrichissement ingestion et instantané livraison: lignes 35 à 78
  - robustesse config et résolution région immuable: lignes 82 à 110
  - vérification end-to-end: lignes 124 à 130
- Conserver le durcissement déjà implémenté à l’étape 15:
  - `PUT /api/whatsapp/message-config` réservé au rôle `ADMIN`
  - signup public incapable d’injecter un rôle administrateur
  - `updatedBy` renseigné depuis `req.userId`
- Créer le référentiel fermé des 14 régions sénégalaises avec codes `SN_*`, alias et indicateur `isHomeDeliveryZone`.
- Ajouter le parsing du nom complet selon la convention retenue: dernier mot comme nom de famille, mots précédents comme prénom(s).
- Étendre `Order` avec un instantané immuable de livraison:
  - `deliveryRegion`, `deliveryRegionCode`
  - `deliveryPreferredMoment`, capturé seulement pour stockage et helpdesk
  - `deliveryAddress`, `deliveryLatitude`, `deliveryLongitude`
  - `browserIp`, `customerLocale`
- Enrichir l’ingestion Shopify/Easysell depuis les adresses, `note_attributes`, GPS, IP et locale, sans scheduling par créneau.
- Résoudre les variantes de message depuis `order.deliveryRegionCode`/`order.deliveryRegion`, jamais depuis la région mutable du client.
- Remplacer le matching `includes('dakar')` par le référentiel canonique des régions.
- Appliquer l’override `payment_method` uniquement aux commandes COD; conserver le moyen de paiement calculé et créer une version pour configurer le `payment_method` pour les commandes non-COD.
- Durcir `updateConfig` pour retourner une erreur `400` structurée sur les mauvais types, sans exception serveur.
- Garder les fallbacks existants lorsqu’une donnée enrichie ou une configuration régionale manque.

Critère d’acceptation:
- Les critères détaillés aux lignes 75 à 78 et 106 à 110 du fichier de directive sont satisfaits, hors assouplissement JWT explicitement ignoré.
- `shopify_payload6.json` produit une commande avec région canonique, moment préféré, adresse de livraison, GPS et IP.
- Une ancienne commande conserve sa propre région pour les relances, même si le client commande ensuite dans une autre région.
- Une commande non-COD ne reçoit jamais le texte `payment_method` réservé au COD.
- Un payload de configuration mal typé retourne `400`, la modification reste ADMIN-only et stocke `updatedBy`.

## Étape 17: Swagger MVP
- Remplacer les métadonnées starter de `swagger.config.ts` par:
  - titre et description du service Shopify WhatsApp/SMS
  - version API du MVP
  - serveurs local, ngrok/dev et production via configuration
  - tags `Health`, `Auth`, `Customers`, `Orders`, `Messages`, `Shopify Webhooks`, `WhatsApp Webhooks`, `WhatsApp Templates`, `Message Config`
- Ajouter `components.securitySchemes.bearerAuth` et l’appliquer à toutes les routes helpdesk protégées.
- Définir des schémas réutilisables:
  - `ApiError`, `ValidationError`, `Pagination`
  - `User`, `Customer`, `Order`, `OrderLineItem`
  - `Message`, `MessageAttempt`
  - `WebhookEvent`, `InboundWhatsAppEvent`
  - `MessageVariableConfig`, `RegionVariant`
  - réponses de job BullMQ pour confirm/cancel/remind/retry
- Documenter toutes les routes réellement montées:
  - `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me`
  - `GET /api/customers`
  - `GET /api/orders`, `GET /api/orders/{id}`
  - `POST /api/orders/{id}/confirm`, `/cancel`, `/remind`
  - `GET /api/messages`, `GET /api/messages/{id}`, `POST /api/messages/{id}/retry`
  - `POST /api/webhooks/shopify/orders-create`
  - `GET/POST /api/webhooks/whatsapp`
  - `GET /api/whatsapp/templates`
  - `GET/PUT /api/whatsapp/message-config`
  - `GET /api/health`
- Pour les listes, documenter pagination, limites et filtres disponibles:
  - clients: `search`, `phone`, `email`, `page`, `limit`
  - commandes: `status`, `customerConfirmationStatus`, `orderName`, `phone`, `page`, `limit`
  - messages: `status`, `channel`, `provider`, `page`, `limit`
- Pour Shopify, documenter les headers HMAC, topic, shop domain et webhook id, ainsi que les réponses idempotentes `202`.
- Pour Meta, documenter les query params de vérification, `X-Hub-Signature-256`, les événements bouton/texte/statut et l’ack rapide.
- Documenter les enums réels des modèles, y compris les statuts confirmation, notification, message, template purpose et traitement inbound.
- Inclure les nouveaux champs de livraison de l’étape 16 dans `Order`.
- Documenter les droits:
  - Bearer JWT pour le helpdesk
  - rôle `ADMIN` obligatoire pour `PUT /api/whatsapp/message-config`
  - webhooks publics protégés par leurs signatures respectives
- Décrire les réponses `200`, `201`, `202`, `400`, `401`, `403`, `404`, `409`, `500` et `502` réellement utilisées.
- Ajouter des exemples anonymisés et ne jamais exposer de token, secret, payload client réel, IP réelle ou URI Atlas.
- Valider automatiquement `/api/docs.json` avec un parseur OpenAPI dans les tests ou un script dédié.

Critère d’acceptation:
- `/api/docs` et `/api/docs.json` représentent toutes les routes montées dans `routes.ts`.
- Chaque route protégée affiche correctement Bearer JWT et, pour la configuration, la restriction ADMIN.
- Les schémas et exemples correspondent aux réponses actuelles des contrôleurs.
- La spécification OpenAPI est valide et ne contient plus de métadonnées “starter”.

## Étape 18: Tests Prioritaires
- Conserver les suites existantes comme baseline:
  - normalisation téléphone
  - validation texte template
  - signature Shopify
  - providers Meta et Termii mockés
  - middleware `requireAdmin`
  - service `MessageVariableConfig`
- Compléter les tests unitaires:
  - référentiel `senegalRegions`: codes, libellés, alias, suffixe Region, inconnu, Dakar/hors Dakar/vide
  - `nameParser`: vide, un/deux/trois mots, espaces multiples et limite des noms composés documentée
  - parsing du payload `CONFIRM_ORDER:{orderId}`
  - transitions et erreurs de `OrderConfirmationService`
  - calcul des échéances de relance, cooldown, expiration et idempotence du sweep
  - validation complète de `MessageVariableConfig`: champs inconnus, variantes inconnues, mauvais types, reset et `updatedBy`
- Ajouter des tests d’ingestion avec les fixtures Shopify réelles:
  - payload direct et payload enveloppé
  - idempotence par webhook id et order id
  - commandes test/annulées/voided persistées mais non enqueued
  - extraction Customer/Product/Order et `note_attributes` Easysell
  - `shopify_payload6.json`: région canonique, moment, adresse, GPS, IP, locale et nom corrigé
  - snapshot régional d’une commande préservé après mise à jour du client
- Ajouter des tests API Supertest:
  - signup/login/me et rejet des tokens invalides
  - lecture clients/commandes/messages avec pagination et filtres
  - détails `404`, retry `409`, confirm/cancel/remind et raisons obligatoires
  - `GET/PUT message-config`: `401`, `403`, succès ADMIN et validation `400`
  - catalogue templates Meta: credentials absents, succès mocké, erreur provider `502`
  - vérification et signature des deux familles de webhooks
- Ajouter des tests WhatsApp inbound:
  - clic bouton valide, doublon, payload inconnu, commande expirée/annulée
  - message libre ou média passant en `needs_attention`
  - statuts `sent/delivered/read/failed` et progression monotone
  - événement inconnu acké sans casser le webhook
- Ajouter des tests queue/worker avec Redis et providers mockés:
  - envoi initial et payload bouton
  - retry/backoff et fallback SMS seulement après échec définitif initial
  - aucun fallback générique pour confirmé, annulé ou reminder
  - variante régionale depuis l’Order immuable
  - `payment_method` configuré seulement pour COD
  - jobs dupliqués idempotents et arrêt propre des workers
- Ajouter des scripts séparés si utile: `test:unit`, `test:integration`, `test:coverage`.
- Utiliser une base de test dédiée (`TEST_MONGODB_URI` ou Mongo éphémère), jamais la base Atlas de production.
- Valider également la spécification Swagger générée.

Critère d’acceptation:
- `npm run tsc -- --noEmit`, les tests unitaires et les tests d’intégration passent sans open handles.
- Les scénarios critiques webhook -> queue -> provider -> base sont couverts sans appel externe réel.
- Les régressions Dakar/hors Dakar, non-COD, idempotence et permissions ADMIN ont chacune un test dédié.
- Un rapport de couverture est disponible, sans imposer artificiellement 100% au MVP.

## Étape 19: Docker Compose, Atlas & Vérification Fonctionnelle Locale
- Préparer un environnement de recette isolé:
  - base Atlas dédiée au dev/test avec utilisateur à privilèges minimaux
  - Redis Docker persistant
  - domaine ngrok fixe pour Shopify et Meta
  - numéro Meta de test et templates approuvés
  - credentials Termii de test ou appels explicitement mockés
- Vérifier toutes les variables `.env.example`, notamment JWT, Shopify, WABA, Meta app secret, templates, Termii, Redis et délais de confirmation.
- Démarrer avec `docker compose up --build` et vérifier:
  - connexion Atlas
  - connexion Redis
  - démarrage API, notification worker, maintenance worker et repeatable job
  - arrêt SIGTERM/SIGINT sans job perdu ni processus bloqué
- Créer explicitement un utilisateur ADMIN de recette sans permettre l’escalade de rôle via signup public.
- Exécuter le parcours nominal complet:
  - webhook Shopify HMAC valide
  - persistance WebhookEvent/Customer/Product/Order/Message
  - job BullMQ puis template Meta avec payload Confirmer
  - webhook Meta bouton
  - commande `confirmed`, template `order_confirmed`, statuts delivered/read
- Exécuter les parcours alternatifs:
  - signature Shopify ou Meta invalide
  - webhook Shopify dupliqué
  - numéro invalide
  - échec WhatsApp initial puis fallback Termii
  - réponse libre -> `needs_attention`
  - annulation et confirmation admin
  - relance manuelle, cooldown, relances automatiques et expiration
  - template Meta absent/rejeté et credentials provider invalides
- Tester la configuration régionale:
  - USER refusé, ADMIN autorisé et `updatedBy` enregistré
  - Dakar et Ziguinchor utilisent les variantes attendues
  - région absente utilise le fallback
  - non-COD conserve son moyen de paiement réel
- Rejouer `shopify_payload6.json` et contrôler région/code, moment, adresse, GPS, IP, locale et parsing du nom.
- Vérifier toutes les listes/filtres/détails/retry via l’API helpdesk et comparer les réponses à Swagger.
- Nettoyer les données et jobs de recette identifiables après validation.

Critère d’acceptation:
- Tous les parcours nominaux et alternatifs ont une preuve dans les logs et MongoDB.
- Les webhooks publics fonctionnent via HTTPS/ngrok avec signatures valides.
- Le service redémarre sans perdre les jobs Redis persistés et sans dupliquer les notifications déjà envoyées.
- Aucune étape ne nécessite un MongoDB local et aucune donnée de recette n’atteint la production.

## Étape 20: Préparation Docker Compose MVP
- Remplacer le Dockerfile de développement actuel par un Dockerfile multi-stage:
  - étape dépendances avec `npm ci`
  - étape build TypeScript
  - image runtime minimale contenant `build/` et les dépendances de production
  - `NODE_ENV=production`, commande `npm start`, utilisateur non-root
- Garder un target ou Dockerfile dev séparé avec `live-dev` et bind mount.
- Clarifier les responsabilités Compose:
  - `docker-compose.yml`: configuration production/simple sans bind mount
  - `docker-compose.dev.yml`: override développement avec source locale et hot reload
  - MongoDB reste Atlas et n’apparaît dans aucun Compose
- Pour `api`:
  - exposer uniquement le port HTTP nécessaire
  - injecter les secrets au runtime, jamais pendant le build
  - ajouter un healthcheck HTTP
  - conserver API et workers dans le même container pour le MVP, en documentant cette décision
- Pour Redis:
  - conserver `redis:7.2-alpine`, mot de passe, AOF et volume nommé
  - ne publier aucun port sur l’hôte en production
  - ajouter healthcheck `redis-cli` authentifié
  - faire dépendre l’API de l’état healthy de Redis
- Ajouter `.dockerignore` complet: `.git`, `node_modules`, `build`, logs, tests lourds, `.env*` hors exemple, captures et payloads sensibles.
- Compléter le shutdown:
  - arrêter workers et schedulers
  - fermer connexions BullMQ/Redis et MongoDB
  - imposer un timeout de sortie avant `SIGKILL`
- Vérifier que le logger est adapté à la production sans transport pretty obligatoire.
- Ajouter des limites raisonnables CPU/mémoire ou les documenter pour Coolify.
- Construire et tester l’image de production indépendamment du bind mount local.

Critère d’acceptation:
- `docker compose -f docker-compose.yml up --build` démarre une image compilée, sans `ts-node-dev` ni bind mount.
- Le dev conserve le hot reload via l’override dédié.
- Les healthchecks API/Redis deviennent healthy et Atlas reste la seule base MongoDB.
- Redis n’est pas exposé publiquement et les données de queue persistent après redémarrage.
- L’arrêt du container ferme proprement HTTP, workers, Redis/BullMQ et MongoDB.

## Étape 21: Préparation Déploiement MVP
- Réécrire le README pour refléter l’état réel:
  - Atlas obligatoire et Redis/BullMQ obligatoires
  - Meta Cloud API + Termii comme providers MVP réellement supportés
  - workflows confirmation, annulation, relance, fallback et helpdesk
  - champs régionaux et configuration `shipping_note`/`payment_method`
  - commandes local, tests, Docker dev et Docker production
- Documenter toutes les variables d’environnement par groupe, caractère obligatoire et exemple non secret.
- Définir la cible VPS + Coolify + Docker Compose:
  - domaine API et certificat HTTPS
  - déploiement depuis Git/image Docker
  - réseau privé Redis
  - volume Redis persistant
  - healthcheck et politique de restart
- Configurer Atlas:
  - utilisateur dédié à privilèges minimaux
  - allowlist de l’IP fixe du serveur
  - base production séparée
  - backups/PITR selon le niveau Atlas choisi
- Configurer Shopify:
  - URL `orders/create`
  - secret HMAC
  - procédure de test et rotation du secret
- Configurer Meta:
  - WABA, phone number id, app secret, verify token et token long-lived/system user
  - URLs GET/POST webhook et abonnement aux champs nécessaires
  - templates approuvés et correspondance exacte de leurs variables
  - procédure de renouvellement/rotation et diagnostic des statuts provider
- Configurer Termii et documenter le sender id, les restrictions et le test du fallback.
- Prévoir une procédure sécurisée de création du premier ADMIN; le signup public ne peut jamais choisir son rôle.
- Ajouter un runbook opérateur:
  - lire les logs par order/message/job id
  - relancer un message failed
  - traiter `needs_attention` et `sms_only`
  - diagnostiquer Redis, Atlas, Meta et Termii
  - gérer un template rejeté/pausé et une queue bloquée
- Ajouter la checklist de release:
  - build, TypeScript, tests, validation Swagger
  - vérification env/secrets
  - déploiement, healthchecks et smoke test
  - rollback vers l’image précédente
- Ajouter monitoring/alertes minimum:
  - erreurs HTTP/webhooks
  - échecs provider et fallback
  - jobs BullMQ failed/stalled
  - indisponibilité Redis/Atlas
- Faire échouer rapidement le démarrage en production si une variable critique manque, sans logger sa valeur.

Critère d’acceptation:
- Un serveur vierge peut être configuré et déployé en suivant uniquement README et runbook.
- Les prérequis Atlas, Redis, Shopify, Meta et Termii sont explicites et testables.
- Le déploiement est HTTPS, les secrets restent hors image/repo et Redis reste privé.
- Une procédure de smoke test et de rollback est disponible.

## Ordre Recommandé De Livraison
1. Config/auth/env.
2. Modèles MongoDB.
3. Normalisation téléphone.
4. HMAC Shopify.
5. Webhook ingestion + idempotence + clients/produits/logs.
6. BullMQ/Redis.
7. Provider et worker Meta WhatsApp.
8. Termii fallback.
9. API dashboard orders.
10. API dashboard messages et retry.
11. Extension modèles/config confirmation client.
12. Webhook WhatsApp entrant.
13. Workflow confirmation, relances et admin.
14. Catalogue des templates WhatsApp dans le dashboard.
15. Configuration régionale `shipping_note` et `payment_method`.
16. Enrichissement ingestion et robustesse config variables.
17. Swagger.
18. Tests ciblés.
19. Docker Compose + Atlas + vérification locale.
20. Préparation Docker Compose MVP.
21. Documentation déploiement.

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
- `shipping_note` et `payment_method` disposent de variantes Dakar/hors Dakar configurables depuis le helpdesk.
- Les régions Easysell forment un référentiel fermé de 14 régions sénégalaises; la zone de livraison à domicile est déterminée par code canonique.
- La région et les informations de livraison sont figées sur chaque `Order` et ne dépendent pas des futures modifications du client.
- Pour le parsing d’un nom complet, le dernier mot est traité comme nom de famille et les mots précédents comme prénom(s), avec la limite connue des noms composés.
- Le moment de livraison préféré est stocké pour le helpdesk uniquement; il ne planifie aucun envoi dans le MVP.
- Le durcissement de l’étape 15 reste actif: modification de la configuration réservée aux ADMIN et auditée via `updatedBy`.
- Les tests automatisés sont utiles mais ne doivent pas retarder excessivement un premier MVP fonctionnel.
