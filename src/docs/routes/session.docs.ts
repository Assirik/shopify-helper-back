/**
 * @openapi
 * /api/session:
 *   post:
 *     tags: [Browser Session]
 *     operationId: captureBrowserSession
 *     summary: Capturer les infos navigateur d’un client
 *     description: >-
 *       Route publique appelée par le script du thème Shopify (`theme/session.js`) quand le
 *       client saisit son téléphone. Le corps est envoyé en `text/plain` (sendBeacon, sans
 *       preflight CORS) et contient du JSON. Un enregistrement par téléphone normalisé, le
 *       dernier envoi remplace le précédent, suppression automatique 1 h après la dernière
 *       mise à jour. À l’arrivée de la commande Shopify, ces infos sont recopiées sur la
 *       commande (capiFbp, capiFbc, capiClientUserAgent, capiEventSourceUrl) si la capture
 *       date de 30 min avant à 5 min après sa création. L’en-tête Origin doit figurer dans
 *       SESSION_CAPTURE_ALLOWED_ORIGINS ; 30 envois par minute au plus par adresse IP.
 *     parameters:
 *       - in: header
 *         name: Origin
 *         required: true
 *         schema: { type: string, example: 'https://ma-boutique.com' }
 *         description: Domaine de la boutique, comparé à SESSION_CAPTURE_ALLOWED_ORIGINS.
 *     requestBody:
 *       required: true
 *       description: JSON sérialisé dans un corps text/plain, 4 ko au plus.
 *       content:
 *         text/plain:
 *           schema:
 *             type: string
 *             maxLength: 4096
 *             example: '{"phone":"77 698 67 80","fbp":"fb.1.1730000000000.123456789","fbc":null,"fbclid":null,"userAgent":"Mozilla/5.0","pageUrl":"https://ma-boutique.com/products/exemple"}'
 *     responses:
 *       204:
 *         description: Infos enregistrées (aucun contenu).
 *       400:
 *         description: >-
 *           Corps invalide, sans écriture : InvalidBody, InvalidJson, PayloadTooLarge,
 *           ValidationFailed (téléphone, userAgent ou pageUrl absent ou vide, champ de mauvais
 *           type ou trop long ; seuls fbp, fbc et fbclid peuvent être null ou absents) ou
 *           InvalidPhone (téléphone non normalisable).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ValidationError' } } }
 *       403:
 *         description: Origine absente, non autorisée, ou liste des origines vide (OriginNotAllowed).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       429:
 *         description: Plus de 30 envois dans la minute pour cette adresse IP (TooManyRequests).
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
export const sessionDocs = true;
