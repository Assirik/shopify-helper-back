# Shopify WhatsApp & SMS Notification Service

Backend Node.js + TypeScript permettant d’envoyer automatiquement des notifications clients après chaque commande Shopify via WhatsApp avec fallback SMS.

Le système expose également une API REST destinée à être consommée par une application frontend servant de dashboard et helpdesk.

## Objectif

Automatiser la communication client après commande Shopify, avec priorité WhatsApp et fallback SMS, tout en offrant un système centralisé de suivi et d’assistance.

Le projet cible principalement le marché sénégalais, notamment Dakar.

---

# Fonctionnalités

## Notifications automatiques

- Réception des webhooks Shopify
- Détection des nouvelles commandes
- Normalisation des numéros sénégalais
- Envoi prioritaire via WhatsApp
- Fallback automatique vers SMS
- Support Meta WhatsApp Cloud API / Twilio WhatsApp
- Support SMS via Termii ou Twilio

## Tracking & Monitoring

- Historique des messages
- Tracking succès / échec
- Stockage des réponses providers
- Statuts détaillés
- Logs techniques
- Retry possible

## Dashboard & Helpdesk API

API REST destinée à un frontend permettant :

- Visualiser les commandes
- Voir les messages envoyés
- Identifier les échecs
- Relancer un message
- Filtrer par statut
- Recherche client
- Support helpdesk

---

# Stack technique

Backend :

- Node.js
- TypeScript
- Express.js
- MongoDB
- Mongoose

Messaging :

- WhatsApp Business API
- Twilio WhatsApp
- Termii SMS
- Twilio SMS

Infrastructure :

- dotenv
- Winston / Pino logging
- Redis (optionnel pour queue)
- BullMQ (optionnel)

Frontend (future) :

- React / Next.js
- Angular
- Vue.js

---

# Architecture

```txt
               Shopify
                   │
                   │ orders/create webhook
                   ▼
      Node.js Notification Backend
                   │
                   │
                   ▼
         Phone Normalization
                   │
                   ▼
          Notification Service
             │             │
             │             │
             ▼             ▼
       WhatsApp        SMS fallback
             │             │
             └──────┬──────┘
                    │
                    ▼
              MongoDB Tracking
                    │
                    ▼
               REST API
                    │
                    ▼
         Dashboard / Helpdesk