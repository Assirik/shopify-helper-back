import swaggerJSDoc from 'swagger-jsdoc';
import config from '../utilities/config/env.config';

const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Node.js TypeScript MongoDB Starter API',
      version: '1.0.0',
      description: 'Base API REST Express, TypeScript et MongoDB.',
    },
    servers: [
      {
        url: config.apiEndpoint,
        description: 'Developpement local',
      },
    ],
    tags: [
      { name: 'Health', description: 'Statut de l API' },
    ],
  },
  apis: ['./src/docs/routes/*.docs.ts'],
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
