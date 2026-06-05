import mongoose from 'mongoose';
import config from '../config/env.config';
import log from '../logger/logger';

export class DatabaseService {
  private static retryCount = 0;

  public static connectWithRetry = () => {
    log.info('Connecting to MongoDB');

    mongoose
      .connect(config.mongodbUri)
      .then(() => {
        log.info('MongoDB connected');
      })
      .catch((err: unknown) => {
        DatabaseService.retryCount += 1;
        log.error({ err }, `MongoDB connection failed. Retry ${DatabaseService.retryCount} in 5 seconds.`);
        setTimeout(DatabaseService.connectWithRetry, 5000);
      });
  };
}
