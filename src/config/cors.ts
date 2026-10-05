import type { CorsOptions } from 'cors';

const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3022',
  'https://thought-expense.nafiziqbal.com',
  'https://admin.thought-expense.nafiziqbal.com',
];

function parseOrigins(): Set<string> {
  const fromEnv = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const frontend = process.env.FRONTEND_URL?.trim();
  const admin = process.env.ADMIN_URL?.trim();

  return new Set(
    [
      ...DEFAULT_ORIGINS,
      ...fromEnv,
      ...(frontend ? [frontend] : []),
      ...(admin ? [admin] : []),
    ].map((o) => o.replace(/\/$/, ''))
  );
}

const allowedOrigins = parseOrigins();

export function corsOptions(): CorsOptions {
  return {
    origin(origin, callback) {
      // Same-origin, curl, mobile apps, server-side
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/$/, '');
      if (allowedOrigins.has(normalized)) {
        callback(null, true);
        return;
      }
      if (
        process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)
      ) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}
