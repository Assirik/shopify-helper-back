# Script de session du thème

`session.js` envoie à notre API le téléphone saisi dans le formulaire de commande EasySell,
avec les infos du navigateur dont Meta a besoin (cookies `_fbp` / `_fbc`, `fbclid`, user agent,
adresse de la page). Le serveur relie ces infos à la commande par le numéro de téléphone.

Le script ne lit aucune autre donnée du formulaire, ne bloque jamais l'envoi de la commande et
avale toutes ses erreurs.

## Installation

1. Ouvrir `session.js` et remplacer la valeur de la constante `ENDPOINT` en tête de fichier par
   l'adresse de l'API, par exemple `https://api.exemple.com/api/session` (le chemin
   `/api/session` reste tel quel).
2. Dans Shopify : **Boutique en ligne → Thèmes → ⋯ → Modifier le code → `layout/theme.liquid`**.
3. Coller tout le contenu du fichier dans une balise `<script>`, **juste avant `</body>`** :

   ```html
     <script>
       /* contenu de session.js */
     </script>
   </body>
   ```

4. Enregistrer. Le domaine de la boutique doit figurer dans la liste des domaines autorisés
   côté serveur, sinon l'API refuse les envois.

## Vérifier

1. Ouvrir la boutique (idéalement avec `?fbclid=TEST` à la fin de l'adresse), puis les outils
   de développement du navigateur, onglet **Réseau**.
2. Saisir un numéro d'au moins 8 chiffres dans le formulaire de commande et attendre une
   seconde : une requête `POST` vers `/api/session` apparaît, avec la réponse `204`.
3. Dans le corps de la requête : `phone`, `fbp`, `fbc`, `fbclid`, `userAgent`, `pageUrl`.
   Avec `?fbclid=TEST`, `fbc` vaut `fb.1.<horodatage>.TEST`.
4. Ressaisir le même numéro n'envoie rien de nouveau ; envoyer le formulaire provoque toujours
   un envoi immédiat, même pour un numéro déjà envoyé.

## Pourquoi le nom de la route est neutre

Les bloqueurs de publicité et les navigateurs protecteurs filtrent les requêtes dont l'adresse
ressemble à du suivi (`track`, `pixel`, `analytics`, `beacon`, `fb`…). Une route nommée
`/api/session` passe inévitablement mieux : ne pas la renommer avec un de ces mots.
