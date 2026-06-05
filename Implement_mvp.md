# Plan D’implémentation Granulaire MVP

## Objectif
Livrer un backend MVP deployable qui reçoit `orders/create` Shopify, valide le webhook, crée une commande, envoie une confirmation WhatsApp Meta via job BullMQ, bascule vers SMS Termii si WhatsApp échoue, trace tout dans MongoDB, puis expose une API dashboard protégée pour lecture et retry.

## Étape 0: Stabilisation Technique
- Ajouter les dépendances nécessaires:
  - `bullmq`
  - `ioredis`
  - `axios`
  - `jest`, `ts-jest`, `supertest`, `@types/jest`, `@types/supertest` si tests activés.
- Créer la configuration Jest minimale, sans viser une couverture exhaustive.
- Vérifier que `npm run tsc -- --noEmit` reste vert après chaque gros bloc.
- Nettoyer les incohérences existantes si elles bloquent le build ou les nouveaux types.

Critère d’acceptation:
- Le projet démarre toujours avec `npm run dev`.
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
  - `redisUrl`
- Mettre à jour `.env.example`.
- Remplacer `RANDOM_TOKEN_SECRET` dans `auth.controller.ts` par `config.jwtSecret`.
- Ajouter un middleware `requireAuth`.
- Protéger les futures routes dashboard avec ce middleware.

Critère d’acceptation:
- Login génère un JWT avec le secret d’environnement.
- Une route protégée rejette les requêtes sans `Authorization: Bearer <token>`.

## Étape 2: Modèles MongoDB MVP
- Créer `Order` avec les champs Shopify utiles:
  - identifiants Shopify
  - client
  - téléphone brut et normalisé
  - total/devise
  - statuts Shopify
  - `notificationStatus`
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
  - `customer.first_name`
  - `customer.last_name`
  - `customer.email`
  - `phone`, `customer.phone`, `shipping_address.phone`, `billing_address.phone`
  - `total_price`
  - `currency`
  - `financial_status`
  - `fulfillment_status`
- Choisir le premier téléphone disponible dans l’ordre:
  - `shipping_address.phone`
  - `billing_address.phone`
  - `customer.phone`
  - `phone`
- Créer/mettre à jour `Order`.
- Créer `WebhookEvent`.
- Créer un premier `Message` WhatsApp en `queued` si numéro valide.
- Si numéro invalide, marquer `Order.notificationStatus = failed`.
- Enqueue le job BullMQ seulement après persistance.
- Répondre vite `202`.

Critère d’acceptation:
- Le webhook crée une commande et un message WhatsApp queued.
- Le endpoint ne fait pas d’appel Meta/Termii directement.
- Un doublon ne recrée pas de message inutile.

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
- Démarrer le worker au boot serveur après init config.
- Ajouter retries BullMQ avec backoff exponentiel.

Critère d’acceptation:
- Un webhook ajoute un job.
- Le worker récupère le job.
- Les erreurs provider ne crashent pas le serveur.

## Étape 7: Provider Meta WhatsApp
- Créer une interface commune `MessagingProvider`.
- Implémenter `MetaWhatsAppProvider`.
- Envoyer un template Meta:
  - `templateName` depuis env
  - `language` = `fr`
  - variables: nom client, numéro commande, total formaté.
- Sauvegarder:
  - provider response
  - provider message id si disponible
  - statut `sent` ou `failed`.
- Mettre à jour `Order.notificationStatus`.

Critère d’acceptation:
- En succès Meta, le message passe à `sent`.
- La commande passe à `sent`.
- Les réponses Meta sont persistées.

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
- Si SMS échoue:
  - commande `failed`.

Critère d’acceptation:
- Échec WhatsApp déclenche automatiquement SMS.
- L’historique garde les deux messages.
- Le dashboard peut voir la chaîne WhatsApp échoué puis SMS envoyé.

## Étape 9: API Dashboard Orders
- Ajouter routes protégées:
  - `GET /api/orders`
  - `GET /api/orders/:id`
- Supporter:
  - pagination `page`, `limit`
  - filtre `status`
  - recherche `orderName`
  - recherche `phone`
- Retourner un format stable:
  - `data`
  - `pagination`
- Inclure un résumé messages dans le détail commande.

Critère d’acceptation:
- Sans JWT: `401`.
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

## Étape 11: Swagger MVP
- Mettre à jour Swagger avec:
  - Auth
  - Shopify webhook
  - Orders
  - Messages
- Documenter les headers Shopify nécessaires.
- Documenter le Bearer token pour dashboard.
- Ajouter exemples de payload/réponse MVP.

Critère d’acceptation:
- `/api/docs` décrit toutes les routes MVP.
- Les routes dashboard affichent leur besoin d’auth JWT.

## Étape 12: Tests Prioritaires
- Ajouter tests unitaires sur:
  - normalisation téléphone
  - HMAC Shopify
- Ajouter tests API Supertest sur:
  - webhook signature invalide
  - webhook signature valide
  - endpoints dashboard sans JWT
  - retry message non failed refusé.
- Mocker Meta, Termii, Redis si nécessaire pour éviter dépendance externe forte.
- Garder les tests comme filet minimal, pas comme blocage du MVP si une intégration externe manque.

Critère d’acceptation:
- Les tests critiques passent localement.
- `npm run tsc -- --noEmit` passe.

## Étape 13: Vérification Fonctionnelle Locale
- Lancer MongoDB et Redis.
- Lancer `npm run dev`.
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

Critère d’acceptation:
- Le flux complet webhook -> queue -> WhatsApp ou fallback SMS -> tracking fonctionne.

## Étape 14: Préparation Déploiement MVP
- Documenter les variables d’environnement obligatoires.
- Ajouter une section README “Run local”.
- Ajouter une section README “Webhook Shopify setup”.
- Ajouter une section README “Meta WhatsApp template”.
- Ajouter une section README “Redis required”.
- Vérifier que l’app fail clairement si une variable critique manque en production.
- Garder les secrets hors repo.

Critère d’acceptation:
- Un déploiement peut être configuré sans lire le code.
- Les prérequis MongoDB/Redis/providers sont explicites.

## Ordre Recommandé De Livraison
1. Config/auth/env.
2. Modèles MongoDB.
3. Normalisation téléphone.
4. HMAC Shopify.
5. Webhook ingestion + idempotence.
6. BullMQ/Redis.
7. Worker.
8. Meta WhatsApp.
9. Termii fallback.
10. API dashboard orders/messages.
11. Retry.
12. Swagger.
13. Tests ciblés.
14. Documentation déploiement.

## Assumptions
- Le MVP reste backend-only.
- Meta WhatsApp utilise un template déjà validé côté Meta.
- Redis est disponible en local et en production.
- Termii est uniquement fallback SMS, pas canal principal.
- Les tests automatisés sont utiles mais ne doivent pas retarder excessivement un premier MVP fonctionnel.
