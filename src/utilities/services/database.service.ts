import mongoose from 'mongoose';
import config from '../config/env.config';
import log from '../logger/logger';

export class DatabaseService {
  private static retryCount = 0;

  public static connectWithRetry = async (): Promise<void> => {
    log.info('Connecting to MongoDB');

    try {
      await mongoose.connect(config.mongodbUri);
      log.info('MongoDB connected');
    } catch (err) {
      DatabaseService.retryCount += 1;
      log.error({ err }, `MongoDB connection failed. Retry ${DatabaseService.retryCount} in 5 seconds.`);

      await new Promise(resolve => setTimeout(resolve, 5000));
      return DatabaseService.connectWithRetry();
    }
  };
}
