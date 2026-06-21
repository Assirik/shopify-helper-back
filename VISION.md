# VISION — Plateforme SaaS de gestion opérationnelle e-commerce (COD-first)

> Document stratégique vivant. Il décrit **le produit visé, le positionnement, les domaines,
> la monétisation et la roadmap**. Il se situe au-dessus des plans techniques :
> - `PLAN_mvp.md` et `Implement_mvp.md` = détail technique de la **Phase 1** uniquement.
> - Ce document = le cap global vers le SaaS.
>
> Itératif : on le met à jour à mesure que les décisions se précisent.

---

## 1. Vision produit

Construire un **SaaS multi-boutique de gestion opérationnelle e-commerce**, en synergie avec
**Shopify** et **Meta / WhatsApp Business**, couvrant à terme la chaîne complète :

```
Stock  →  Commande  →  Confirmation client  →  Livraison  →  Encaissement
```

Le produit démarre par un **wedge à forte valeur immédiate** (anti-fraude COD + suivi du cash),
puis s'enrichit de **modules vendables séparément** (stock, livraison, inbox, analytics…).

### 1.1 Problème central (le « pourquoi »)

Sur le marché cible (Sénégal / Afrique de l'Ouest), le e-commerce est **massivement en COD**
(paiement à la livraison). Cela génère des pertes structurelles :

- commandes fantômes / faux numéros / clients récidivistes qui ne réceptionnent pas ;
- refus à la livraison → frais de livraison perdus ;
- aucune visibilité fiable sur le **cash collecté par les livreurs vs remis au marchand** ;
- outils de capture de commande (Easysell sur Meta Ads) **non éditables** → impossible de
  corriger une variante, obligation de recréer la commande.

### 1.2 Proposition de valeur

> **« Je réduis tes commandes fantômes, je flague les mauvais clients, et je te dis
> exactement où passe ton cash. »**

---

## 2. Positionnement & marché

### 2.1 Angle principal (positionnement de lancement)

**Anti-fraude COD + suivi du cash.** C'est le wedge : autosuffisant, à valeur monétaire directe,
vendable rapidement.

### 2.2 Segments cibles

| Segment | Réalité marché | Besoin dominant |
|---|---|---|
| **Marchands Meta / Easysell avec stock** | Majoritaire au Sénégal (le pur dropshipping sans stock est rare) | Confirmation COD, stock, multi-boutique |
| **Marchands e-commerce établis** (marque propre) | Vrai stock, parfois plusieurs boutiques Shopify | Stock fiable, ops, analytics marge |
| **Marchands avec boutique physique** | Vendent aussi en comptoir à des clients sur place | Stock partagé entre ventes en ligne et ventes comptoir |

> Note : ces segments ne sont pas exclusifs. Un même marchand peut faire e-commerce **et**
> boutique physique. Le stock central doit servir les deux.

### 2.3 Différenciateur stratégique (moat)

**Le score de fiabilité client mutualisé entre marchands.** Parce que la plateforme est
multi-tenant, le signal anti-fraude (no-shows, refus, faux numéros) est **partagé** : un client
mauvais payeur chez d'autres marchands est flaggé chez le nouveau.
→ **Effet de réseau** : le produit devient plus fort à chaque client gagné, impossible à
répliquer pour un concurrent mono-boutique.

---

## 3. Domaines fonctionnels (futurs modules)

Le SaaS se décompose en **6 domaines**. Chacun deviendra un module activable/vendable.

| # | Domaine | Rôle | Phase |
|---|---|---|---|
| 1 | **Identity & Tenancy** | Boutiques (tenants), utilisateurs, rôles & permissions (RBAC), accès employés | Fondation + Phase 2 |
| 2 | **Confirmation / Messaging** | WhatsApp/SMS, confirmation COD, relances, inbox | **Phase 1 (wedge)** |
| 3 | **Anti-fraude & Cash** | Score fiabilité client mutualisé, réconciliation cash COD | **Phase 1 (wedge)** |
| 4 | **Orders** | Ingestion, édition (correction variante Easysell), tags, mise en attente, assignation | Phase 2 |
| 5 | **Stock / Catalogue** | Catalogue canonique source de vérité, ledger de mouvements, sync Shopify, vente comptoir | Phase 3 |
| 6 | **Delivery** | Gestionnaire de livraison + app livreur, preuve de livraison, statuts, cash collecté | Phase 4 |

---

## 4. Modèle de monétisation

**Abonnement de base + modules à la carte.**

- Le **wedge (Confirmation COD + Anti-fraude/Cash)** = cœur de l'abonnement, toujours actif.
- Les autres domaines (**Stock, Livraison, Inbox, Analytics…**) = **modules vendus séparément**.
- Conséquence technique directe : **couche d'entitlements par boutique** (cf. §6, fondation #4).
  Chaque module est activable/désactivable par tenant via un flag, sans refactor.

> Détails de pricing (paliers, metering par volume de messages / commandes) : **à itérer**.

---

## 5. Architecture cible

### 5.1 Style

**Monolithe modulaire** (un seul déploiement, modules par domaine bien séparés).
- ❌ Pas de microservices au démarrage (inadapté à une petite équipe).
- ✅ Extraction d'un service possible plus tard si un domaine l'exige (ex : Delivery).

### 5.2 Intégrations externes

| Système | Rôle | Implication |
|---|---|---|
| **Shopify** | Source (commandes via webhook) **et** cible (push stock/produits via Admin API) | Le flux n'est plus seulement réactif : on écrit aussi dans Shopify |
| **Meta / WhatsApp Cloud API** | Canal de confirmation (templates approuvés, bouton Quick Reply `CONFIRM_ORDER:{id}`) | Compte Business **déjà créé, vérifié, templates approuvés** ✅ |
| **Termii** | Fallback SMS (informatif, ne confirme pas → `sms_only`) | Pis-aller, jamais canal de confirmation |
| **MongoDB Atlas** | Base de données (jamais conteneurisée) | `MONGODB_URI` pointe vers Atlas |
| **Redis** | File BullMQ (conteneurisé, privé) | Point de défaillance accepté en MVP |

### 5.3 Bascule mono → multi-boutique (décision structurante)

- **Aujourd'hui (Phase 1)** : mono-boutique, authentification via un seul
  `SHOPIFY_WEBHOOK_SECRET`.
- **Multi-boutique (Phase 2)** : impose de devenir une **vraie Shopify App (OAuth)** —
  access token par boutique, enregistrement des webhooks par boutique, onboarding self-service.
- ⚠️ On ne peut pas « ajouter le multi-boutique plus tard sans toucher l'accès Shopify ».
  D'où les fondations sans-regret ci-dessous pour ne pas se bloquer.

### 5.4 Front-end

- Le backend expose une **API REST** (pas de front dans ce dépôt).
- Front-end dashboard prévu **plus tard, séparément**, en **Vue.js**.

---

## 6. Fondations « sans-regret » (à poser dès la Phase 1)

Peu coûteuses maintenant, très coûteuses à rétrofitter. Posées **dès le MVP**, même si une seule
boutique existe :

1. **`shopId` (tenant) sur tous les modèles** — Order, Customer, Product, Message, etc.
   Rétrofitter l'isolation tenant sur une base remplie = cauchemar.
2. **Modèle `Shop` minimal** — les secrets/tokens Shopify & Meta pointent vers une entité `Shop`
   (même une seule ligne en dur au début) plutôt que vers l'`.env` global. Prépare l'OAuth.
3. **Structure en modules par domaine** — `src/modules/orders/`, `src/modules/messaging/`…
   plutôt que des couches techniques globales (`controllers/`, `services/`).
4. **Couche d'entitlements par module** — modèle `Subscription`/`Entitlements` par `Shop` +
   un garde unique (`requireModule('stock')`). Au lancement : wedge toujours actif, autres
   modules `false`. Activer un module = passer un flag, zéro refactor.

> Tout le reste (RBAC complet, sync stock, delivery, OAuth) = **plus tard**. On ne le code pas
> maintenant. On pose seulement ce qui éviterait une réécriture.

---

## 7. Principes de design du domaine Stock (Phase 3 — pour mémoire)

Décidé pendant le cadrage, à implémenter en Phase 3 :

- **Emplacement unique** : un seul stock centralisé par marchand (le multi-emplacement est
  extrêmement rare → non modélisé, mais le ledger permettra d'ajouter un `locationId` plus tard
  sans blocage).
- **Catalogue canonique interne = source de vérité**, découplé des IDs Shopify.
- **Stock géré en ledger de mouvements** (réception, vente Shopify, vente comptoir, retour,
  ajustement) plutôt qu'un simple nombre. Donne gratuitement l'audit, la réconciliation et
  l'analytics marge/COGS.
- **Vente en boutique physique = saisie de vente manuelle** (pas un vrai POS), simple mouvement
  de stock décrémentant le même stock central.
- **Mapping `produit canonique ↔ {shopId, shopifyVariantId}` en 1→N** : presque toujours 1→1,
  mais on garde une table de mapping pour gérer le cas rare « même produit sur 2 boutiques »
  sans rien casser.
- **Re-push de la quantité vers chaque Shopify mappé** après chaque mouvement.

> En Phase 1, on ne pose que la **graine** : modèle `Product` canonique + `shopId`.
> Pas de ledger, pas de saisie comptoir, pas de sync.

---

## 8. Roadmap par phases

### Phase 1 — Wedge : Confirmation COD + Anti-fraude/Cash (LANCEMENT)
Objectif : produit minimal **vendable et encaissable**, autosuffisant (ne dépend pas du stock).
- Confirmation COD par WhatsApp (worker, provider Meta, fallback SMS, webhook entrant, relances).
- Score de fiabilité client + blacklist (mutualisé entre boutiques).
- Réconciliation cash COD (attendu → collecté livreur → remis marchand → écarts).
- API dashboard (lecture, retry, confirm/cancel/remind).
- **Écrit dès le départ avec les 4 fondations sans-regret** (`shopId`, `Shop`, modules,
  entitlements).
- Détail technique : `PLAN_mvp.md` + `Implement_mvp.md`.

### Phase 2 — Multi-tenant & Orders
- Bascule vers **Shopify App OAuth** + onboarding self-service des boutiques.
- **RBAC complet** (rôles & permissions employés) + journal d'audit.
- Module **Orders** : édition de commande / correction de variante (pain Easysell), tags,
  mise en attente, assignation.
- Consommation par le front **Vue.js**.

### Phase 3 — Stock / Catalogue omnicanal
- Catalogue canonique + ledger + mapping multi-shop + vente comptoir + sync Shopify
  (cf. §7).
- Résolution structurelle du pain Easysell (variante).

### Phase 4 — Livraison
- Gestionnaire de livraison + **app livreur** (preuve de livraison photo/signature/GPS,
  statuts temps réel, cash collecté).
- Boucle complète réception → livraison automatisée, synchronisée Shopify + Meta.

### Transverse (au fil des phases)
- Inbox WhatsApp partagée (helpdesk multi-agents).
- Récupération de commandes abandonnées / re-engagement.
- Analytics « Ad → Livré → Profit » (marge nette réelle par produit/campagne).
- Facturation / abonnement / metering.
- Notifications marchand (alertes WhatsApp/Telegram).

---

## 9. Décisions actées

- ✅ Positionnement principal : **anti-fraude COD + cash**.
- ✅ Lancement = **wedge minimal**, puis ajout de **modules vendus séparément**.
- ✅ Cibles : marchands Meta/Easysell **avec stock**, marchands établis, marchands boutique
  physique.
- ✅ Stock : **emplacement unique**, ledger, mapping 1→N, vente comptoir manuelle.
- ✅ Architecture : **monolithe modulaire**, multi-tenant.
- ✅ 4 fondations sans-regret posées dès la Phase 1.
- ✅ Front-end séparé en **Vue.js**, API REST côté backend.
- ✅ Compte Meta WhatsApp Business prêt (vérifié, templates approuvés) ; ngrok + webhooks
  Shopify configurés.

## 10. Points encore ouverts (à itérer)

- Modèle de pricing détaillé (paliers, metering par volume).
- Détail de la bascule technique mono → multi-boutique (OAuth Shopify, migration des données).
- Mécanique précise du score de fiabilité (variables, pondération, seuils, RGPD/consentement
  sur la mutualisation des données entre marchands).
- Détail du flux de réconciliation cash (rôles livreur, remises, périodes).
- Intégration éventuelle de transporteurs tiers en plus des livreurs propres.
