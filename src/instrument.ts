import 'dotenv/config';
import * as Sentry from '@sentry/node';

function profilingIntegration():
  ReturnType<typeof import('@sentry/profiling-node').nodeProfilingIntegration> | undefined {
  try {
    const { nodeProfilingIntegration } =
      require('@sentry/profiling-node') as typeof import('@sentry/profiling-node');
    return nodeProfilingIntegration();
  } catch {
    return undefined;
  }
}

const dsn = process.env.SENTRY_DSN;
const profiling = profilingIntegration();

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    integrations: profiling ? [profiling] : [],
    tracesSampleRate: 1.0,
    profileSessionSampleRate: 1.0,
    profileLifecycle: 'trace',
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
  });
}
