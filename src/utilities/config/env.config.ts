import dotenv from 'dotenv';

dotenv.config();

const port = Number(process.env.PORT) || 3600;
const apiEndpoint = process.env.API_ENDPOINT || `http://localhost:${port}`;
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : '*';

export default {
  port,
  apiEndpoint,
  environment: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/starter-kit',
  allowedOrigins,
};
