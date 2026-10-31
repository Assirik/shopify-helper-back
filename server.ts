import { createServer } from 'http';
import os from 'os';
import app from './src/app';
import config from './src/utilities/config/env.config';
import { checkCapiStartup, describeCapiStatus } from './src/utilities/config/capiStartup';
import log from './src/utilities/logger/logger';
import { DatabaseService } from './src/utilities/services/database.service';
import { scheduleConfirmationSweep } from './src/queues/notification.queue';
import { CAPI_PURCHASE_SWEEP_INTERVAL_MS, scheduleCapiPurchaseSweep } from './src/queues/capi.queue';
import {
  startMaintenanceWorker,
  startNotificationWorker,
  stopMaintenanceWorker,
  stopNotificationWorker
} from './src/workers/notification.worker';
import { startCapiPurchaseWorker, stopCapiPurchaseWorker } from './src/workers/capiPurchase.worker';
import { startCapiPurchaseSweepWorker, stopCapiPurchaseSweepWorker } from './src/workers/capiPurchaseSweep.worker';

const capiError = checkCapiStartup(config.metaCapi);
if (capiError) {
  log.fatal(capiError);
  process.exit(1);
}
log.info(describeCapiStatus(config.metaCapi), `CAPI ${config.metaCapi.enabled ? 'enabled' : 'disabled'}`);

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
  startMaintenanceWorker();
  startCapiPurchaseWorker();
  startCapiPurchaseSweepWorker();

  try {
    await scheduleConfirmationSweep(config.confirmation.sweepIntervalMinutes);
    log.info({ intervalMinutes: config.confirmation.sweepIntervalMinutes }, 'Confirmation sweep scheduled');
  } catch (err) {
    log.error({ err }, 'Failed to schedule confirmation sweep');
  }

  try {
    await scheduleCapiPurchaseSweep();
    log.info({ intervalMinutes: CAPI_PURCHASE_SWEEP_INTERVAL_MS / 60_000 }, 'CAPI purchase sweep scheduled');
  } catch (err) {
    log.error({ err }, 'Failed to schedule CAPI purchase sweep');
  }
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutting down server');

  await stopNotificationWorker();
  await stopMaintenanceWorker();
  await stopCapiPurchaseWorker();
  await stopCapiPurchaseSweepWorker();
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
