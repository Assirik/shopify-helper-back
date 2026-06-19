# Plan — Correctifs ingestion & robustesse config variables (à intercaler dans `Implement_mvp.md`)

## Context
L'analyse des 6 `shopify_payload*.json` réels (commandes COD Easysell) et du formulaire Easysell a révélé :
1. **Données Shopify riches non exploitées** : moment de livraison préféré, coordonnées GPS, adresse de livraison distincte, IP, locale client.
2. **Région prise depuis `customer.region` (mutable)** dans le worker → une relance d'ancienne commande peut utiliser la région d'une commande plus récente. Il faut un **instantané immuable** sur l'Order.
3. **Matching Dakar fragile** (`includes('dakar')` → « Hors Dakar » faux positif). Le dropdown Easysell est un **ensemble fermé de 14 régions** (`SN_DK`…`SN_ZG`) → matching déterministe possible.
4. **Bug nom à 3 mots** : Easysell/Shopify met le 1er mot en `first_name` et le reste en `last_name`. Convention sénégalaise = **dernier mot = nom de famille**, le reste = prénom(s).
5. **Anomalies config variables (revue)** : payload mauvais type → 500 ; override `payment_method` appliqué même hors COD ; pas de traçabilité de l'admin ; tests insuffisants.

Décisions produit validées :
- **Moment de livraison** : capturer seulement (stock + helpdesk), pas de variable de template, pas de scheduling (sans-regret).
- **Accès config** : JWT simple conservé (pas de rôle admin), on ajoute juste `updatedBy`.

Objectif : extraire/figer un **instantané livraison immuable** à l'ingestion, fiabiliser la détection région, corriger le nom, et durcir la config des variables — sans casser le comportement actuel (fallbacks systématiques).

## Placement & ordre interne
Tout ce lot s'intercale **entre l'Étape 13 bis et l'Étape 14**, sous forme de **deux étapes contiguës** : **Étape 13 ter** (fondations + ingestion) puis **Étape 13 quater** (config + worker). C'est cohérent avec l'état réel du code (étapes 1→13 bis déjà implémentées) : on enrichit/corrige, puis Swagger (14) documente les nouveaux champs/endpoints déjà en place, puis les tests (15).

Dépendance d'ordre **interne** à respecter dans le bloc : `senegalRegions` + `nameParser` + champs `delivery*` du modèle **avant** l'extraction d'ingestion, elle-même **avant** la lecture région côté config/worker, et tests à la fin.

---

## Fichiers concernés (réutiliser l'existant)
- Ingestion : `src/controllers/shopifyWebhook.controller.ts` — réutiliser `getNoteAttribute`, `getFirstString`, `getCustomerAddress`, `buildCustomerName`, `getCustomerName`, `getNoteAttributesMap`, `isCashOnDelivery`.
- Modèles : `src/models/Order.ts`, `src/models/Customer.ts`.
- Config variables : `src/models/MessageVariableConfig.ts`, `src/utilities/services/messageVariableConfig.service.ts` (`isDakarRegion`, `resolveForRegion`, `updateConfig`), `src/controllers/messageVariableConfig.controller.ts`.
- Worker : `src/workers/notification.worker.ts` (`buildTemplateVariables`, `sendMetaTemplate`, `PURPOSES_WITH_REGION_VARIANTS`, `getPaymentMethod`).
- Auth : `src/middlewares/requireAuth.ts` (expose déjà `req.userId`).
- Validation : `src/utilities/validation/templateText.ts`.
- Nouveau : `src/utilities/reference/senegalRegions.ts`, `src/utilities/services/nameParser.ts` (+ tests).

---

## Étape 13 ter — Enrichissement Ingestion & Instantané Livraison
> À intercaler **après l'Étape 13 bis**. Complète aussi les listes de champs des Étapes 2 et 5 (cf. « Mises à jour documentaires »).

### 13 ter.1 — Référentiel des régions (`src/utilities/reference/senegalRegions.ts`)
- Table des 14 régions : `{ code, label, aliases[], isHomeDeliveryZone }`.
  - `SN_DK Dakar (isHomeDeliveryZone=true)`, `SN_DB Diourbel Region`, `SN_FK Fatick`, `SN_KA Kaffrine`, `SN_KL Kaolack`, `SN_KE Kédougou`, `SN_KD Kolda`, `SN_LG Louga`, `SN_MT Matam`, `SN_SL Saint-Louis`, `SN_SE Sédhiou`, `SN_TC Tambacounda Region`, `SN_TH Thiès Region`, `SN_ZG Ziguinchor`.
- `normalizeRegion(value)` : `NFD` + suppression diacritiques (`/[̀-ͯ]/g`) + lowercase + trim + retrait du suffixe « region ». (Centralise la logique aujourd'hui dans `messageVariableConfig.service.ts`.)
- `resolveRegion(rawValue): { code?, label? }` : matche un libellé OU un code (`SN_DK`) vers l'entrée canonique (via `normalizeRegion` sur `label`+`aliases`). Renvoie `{}` si inconnu.
- `isHomeDeliveryRegion(rawValue): boolean` : `true` si la région résolue a `isHomeDeliveryZone` (aujourd'hui = Dakar uniquement). Remplace `includes('dakar')`.

### 13 ter.2 — Parsing du nom (`src/utilities/services/nameParser.ts`)
- `splitFullName(fullName): { firstName, lastName }` : tokenise sur espaces ; **dernier token = `lastName`**, le reste = `firstName`. 1 seul mot → `lastName=mot`, `firstName=''`. Vide → `{}`.
- Heuristique orientée Sénégal, documentée (limite connue : noms de famille composés).

### 13 ter.3 — Extension du modèle `Order` (`src/models/Order.ts`)
Ajouter (tous optionnels, fallback géré côté lecture) :
- `deliveryRegion?: string` (libellé canonique), `deliveryRegionCode?: string` (`SN_DK`…), index sur `deliveryRegionCode`.
- `deliveryPreferredMoment?: string` (valeurs Easysell : `Toute la journée | Matinée | Après Midi | Soir (avant 20h)`).
- `deliveryAddress?: string` (point de livraison réel).
- `deliveryLatitude?: number`, `deliveryLongitude?: number`.
- `browserIp?: string`, `customerLocale?: string`.
- Mettre à jour l'interface `IOrder`.

### 13 ter.4 — Extraction à l'ingestion (`shopifyWebhook.controller.ts`)
- Région : `resolveRegion(getFirstString(shipping_address.province, note "Région"/"Region"))` → stocker `deliveryRegion` + `deliveryRegionCode`. Conserver le libellé brut si non résolu.
- Moment : `getNoteAttribute(payload, 'Moment de livraison préféré')` → `deliveryPreferredMoment` (garder tel quel ; ne pas rejeter une valeur inconnue, juste logguer).
- Adresse de livraison : `getFirstString(shipping_address.address2, note "Adresse de livraison")` → `deliveryAddress`.
- GPS : `shipping_address.latitude/longitude` → `deliveryLatitude/Longitude` (Number).
- IP : `getFirstString(payload.browser_ip, note "IP Address")` → `browserIp`.
- Locale : `payload.customer_locale` → `customerLocale`.
- **Nom** : calculer `splitFullName(customerName)` (où `customerName` vient déjà de `getCustomerName`, basé sur « Nom complet ») et utiliser le résultat pour `Customer.firstName/lastName` à la place de `payload.customer.first_name/last_name`. **Ne pas toucher** à `Order.customerName`/`Customer.fullName` (déjà corrects).

### 13 ter.5 — `Customer` (`src/models/Customer.ts`)
- Optionnel : normaliser aussi `Customer.region` via `resolveRegion`. Le champ `region` existant reste.

### 13 ter.6 — Tests (cf. pointeur Étape 15)
- `senegalRegions` : `resolveRegion` (libellé, code, suffixe « Region », inconnu) ; `isHomeDeliveryRegion` (Dakar / Région de Dakar / Hors Dakar / Ziguinchor / vide).
- `nameParser.splitFullName` : 1, 2, 3 mots, vide, espaces multiples.
- Intégration ingestion payload6 : `deliveryRegionCode`, `deliveryPreferredMoment`, `deliveryAddress`, GPS, `firstName/lastName`.

**Critère d'acceptation 13 ter :**
- Une commande payload6 produit `deliveryRegion="Ziguinchor"`, `deliveryRegionCode="SN_ZG"`, `deliveryPreferredMoment="Après Midi"`, `deliveryAddress="Cap Skiring"`, GPS renseigné, `browserIp` renseigné.
- « Isadore Mangala Ndoye » → `Customer.firstName="Isadore Mangala"`, `lastName="Ndoye"` ; `customerName` inchangé « Isadore Mangala Ndoye ».
- `isHomeDeliveryRegion("Dakar")===true`, `isHomeDeliveryRegion("Hors Dakar")===false`, `isHomeDeliveryRegion("Ziguinchor")===false`.

---

## Étape 13 quater — Robustesse Config Variables & Résolution Région Immuable
> À intercaler **juste après l'Étape 13 ter**. Dépend de 13 ter (référentiel + champs `delivery*` de l'Order).

### 13 quater.1 — Détection région canonique (`messageVariableConfig.service.ts`)
- Remplacer `isDakarRegion` (sous-chaîne) par un appel à `isHomeDeliveryRegion` du référentiel (13 ter.1). Garder le nom exporté ou renommer en `isHomeDeliveryRegion` (mettre à jour les usages).

### 13 quater.2 — Résolution depuis l'Order immuable (`notification.worker.ts`)
- Dans `sendMetaTemplate`, résoudre la variante via **`order.deliveryRegionCode` / `order.deliveryRegion`** (instantané) au lieu de `customer.region`.
- `MessageVariableConfigService.resolveForRegion(region?)` conserve sa signature ; on lui passe `order.deliveryRegion`.

### 13 quater.3 — `payment_method` borné au COD (`notification.worker.ts`)
- N'appliquer l'override `payment_method` (variante régionale) **que si `order.isCashOnDelivery`** ; sinon fallback `getPaymentMethod(order)`. `shipping_note` reste appliqué dans tous les cas.

### 13 quater.4 — Validation type-safe de la config (`messageVariableConfig.service.ts`)
- Dans `updateConfig`, ordonner les checks : `undefined`→ignore ; `null`→unset ; **`typeof !== 'string'`→erreur 400** ; `''`→unset ; sinon `validateTemplateText`. Plus aucun `400` transformé en `500` sur payload mal typé.

### 13 quater.5 — Traçabilité config (`MessageVariableConfig.ts`, controller, service)
- Ajouter `updatedBy?: string` (le `req.userId`). Le controller passe `req.userId` à `updateConfig` ; le service le pose dans `$set`.
- (Historique complet = Perspectives, non inclus.)

### 13 quater.6 — Tests (cf. pointeur Étape 15)
- `updateConfig` : update partiel, reset `null`, **payload mauvais type → erreur 400** (pas d'exception).
- Worker : variante Dakar vs hors-Dakar choisie d'après `order.deliveryRegion` ; `payment_method` non écrasé hors COD.

**Critère d'acceptation 13 quater :**
- Une relance d'ancienne commande utilise la région **de cette commande** (immuable), pas celle du client.
- `PUT /message-config { shippingNote: { dakar: 42 } }` → **400** structuré (pas 500).
- Une commande non-COD reçoit le `payment_method` calculé, jamais le texte COD configuré.
- La config enregistre `updatedBy`.

---

## Mises à jour documentaires de `Implement_mvp.md` (à appliquer quand on éditera le fichier)
- Insérer **Étape 13 ter** et **Étape 13 quater** ci-dessus entre l'Étape 13 bis et l'Étape 14.
- **Étape 2** (modèle Order) : ajouter les champs livraison (`deliveryRegion`, `deliveryRegionCode`, `deliveryPreferredMoment`, `deliveryAddress`, `deliveryLatitude/Longitude`, `browserIp`, `customerLocale`).
- **Étape 5** (ingestion) : ajouter l'extraction GPS / moment / adresse de livraison / IP / locale + dérivation région canonique + correctif nom.
- **Étape 15** (tests) : ajouter un pointeur vers 13 ter.6 et 13 quater.6 (`senegalRegions`, `nameParser`, `updateConfig` mauvais type, intégration ingestion + worker).
- **Ordre Recommandé De Livraison** : intercaler « 14 bis. Enrichissement ingestion + instantané livraison » et « 14 ter. Robustesse config variables » après le point 14 (workflow confirmation).
- **Assumptions** : « Région = ensemble fermé Easysell (14 régions SN) ; détection zone domicile par code canonique. Nom : dernier mot = nom de famille (convention Sénégal). Instantané livraison figé sur l'Order. »

---

## Vérification end-to-end
1. `npx tsc --noEmit` vert.
2. `npx jest` — nouvelles suites (`senegalRegions`, `nameParser`, `messageVariableConfig`) + existantes vertes.
3. Rejouer un payload local : `POST /api/webhooks/shopify/orders-create` avec `shopify_payload6.json` (HMAC valide) → vérifier en base l'Order enrichi (région code, moment, GPS, deliveryAddress) et le `Customer` (firstName/lastName corrigés).
4. `PUT /api/whatsapp/message-config` avec variantes Dakar/hors-Dakar, puis déclencher un envoi (relance) sur une commande Dakar et une commande Ziguinchor → vérifier la bonne variante `shipping_note`/`payment_method` dans le `Message` envoyé.
5. `PUT /message-config { shippingNote: { dakar: 42 } }` → 400 structuré.
6. Vérifier qu'une commande non-COD (ex. payload de test prépayé) ne reçoit pas le texte COD.

## Hors périmètre (Perspectives)
- `delivery_moment` comme variable de template (re-validation Meta) ; scheduling des relances par créneau.
- Lien Maps GPS et signaux anti-fraude (IP/géoloc) → module anti-fraude COD.
- Rôle admin strict sur la config ; historique complet des modifications.
- `customer_locale` → langue de template dynamique.
