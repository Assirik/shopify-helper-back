import mongoose from 'mongoose';
import config from '../utilities/config/env.config';
import log from '../utilities/logger/logger';
import { backfillAttentionQueue } from '../utilities/services/attentionBackfill.service';

const run = async () => {
  try {
    await mongoose.connect(config.mongodbUri);
    const result = await backfillAttentionQueue();
    log.info(result, 'Attention queue backfill completed');
  } catch (error) {
    log.error({ err: error }, 'Attention queue backfill failed');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  void run();
}
