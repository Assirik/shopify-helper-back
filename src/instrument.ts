// Must be the first import of server.ts so Sentry can instrument modules loaded afterwards.
import './utilities/config/env.config'; // loads dotenv before SENTRY_DSN is read
import { initSentry } from './utilities/sentry/sentry';

initSentry();
