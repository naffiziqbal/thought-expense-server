process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
delete process.env.SENTRY_DSN;
