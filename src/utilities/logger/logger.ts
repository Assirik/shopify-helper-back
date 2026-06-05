import logger from 'pino';
import dayjs from 'dayjs';

// If you want pretty printing, use the transport option with pino-pretty
const log = logger({
  base: {
    pid: false
  },
  timestamp: () => `, "time":"${dayjs().format('YYYY-MM-DDTHH:mm:ss')}"`,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
      singleLine: true,
      errorLikeObjectKeys: ['err', 'error', 'stack'] // Ensures stack traces are shown
    }
  },
  serializers: {
    err: logger.stdSerializers.err
  }
});

export default log;
