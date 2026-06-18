import { createServer } from 'http';
import os from 'os';
import app from './src/app';
import config from './src/utilities/config/env.config';
import log from './src/utilities/logger/logger';
import { DatabaseService } from './src/utilities/services/database.service';
import { startNotificationWorker, stopNotificationWorker } from './src/workers/notification.worker';

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
server.listen(port, async () => {
  log.info(`Server listening at ${config.apiEndpoint}`);
  logNetworkAddresses();

  await DatabaseService.connectWithRetry();
  startNotificationWorker();
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutting down server');

  await stopNotificationWorker();
  server.close(() => {
    log.info('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(err => {
    log.error({ err }, 'Shutdown failed');
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(err => {
    log.error({ err }, 'Shutdown failed');
    process.exit(1);
  });
});
