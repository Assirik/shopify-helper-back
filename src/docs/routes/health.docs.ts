/**
 * @openapi
 * /api/health:
 *   get:
 *     tags: [Health]
 *     operationId: getHealth
 *     summary: Vérifier l’état de l’API
 *     responses:
 *       200:
 *         description: Le processus API fonctionne.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status, uptime, timestamp]
 *               properties:
 *                 status: { type: string, enum: [ok] }
 *                 uptime: { type: number, minimum: 0, example: 42.5 }
 *                 timestamp: { type: string, format: date-time }
 */
export const healthDocs = true;
