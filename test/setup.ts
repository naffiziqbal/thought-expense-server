process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
delete process.env.SENTRY_DSN;
// Never post to the real Telegram chat from tests (alerts.test.ts sets its own fakes).
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_ALERT_CHAT_ID;
delete process.env.ADMIN_REQUIRE_TOTP;
