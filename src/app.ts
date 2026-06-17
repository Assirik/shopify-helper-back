import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { IncomingMessage, ServerResponse } from 'http';
import { swaggerSpec } from './docs/swagger.config';
import router from './routes/routes';
import config from './utilities/config/env.config';

const app = express();

const captureRawBody = (req: IncomingMessage, _res: ServerResponse, buffer: Buffer) => {
  if (buffer.length) {
    (req as express.Request).rawBody = Buffer.from(buffer);
  }
};

app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: false }));
app.use(cors({ origin: config.allowedOrigins }));

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api/docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

app.use(router);

export default app;
