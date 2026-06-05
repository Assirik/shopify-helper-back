import { createServer } from 'http';
import os from 'os';
import app from './src/app';
import config from './src/utilities/config/env.config';
import log from './src/utilities/logger/logger';
import { DatabaseService } from './src/utilities/services/database.service';

const port = config.port;
app.set('port', port);

const networkInterfaces = os.networkInterfaces();
const server = createServer(app);

const errorHandler = (error: any) => {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const address = server.address();
  const bind = typeof address === 'string' ? `pipe ${address}` : `port ${port}`;

  switch (error.code) {
    case 'EACCES':
      log.error(`${bind} requires elevated privileges.`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      log.error(`${bind} is already in use.`);
      process.exit(1);
      break;
    default:
      throw error;
  }
};

const logNetworkAddresses = () => {
  for (const name in networkInterfaces) {
    const networkInterface = networkInterfaces[name];

    if (!networkInterface) {
      continue;
    }

    for (const net of networkInterface) {
      if (net.family === 'IPv4' && !net.internal) {
        log.info(`Network address: http://${net.address}:${port}`);
      }
    }
  }
};

server.on('error', errorHandler);
server.listen(port, () => {
  log.info(`Server listening at ${config.apiEndpoint}`);
  logNetworkAddresses();
  DatabaseService.connectWithRetry();
});
