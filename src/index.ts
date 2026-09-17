import "./instrument";
import * as Sentry from "@sentry/node";

import { app } from "./app";
import { connectRedis } from "./config/redis";
import { initRateLimiters } from "./middleware/rateLimit";
import { logger } from "./config/logger";
import { initPinecone } from "./services/pinecone.service";
import { startParseWorkers, stopParseWorkers } from "./workers/parse.worker";
import { startBriefingWorker, stopBriefingWorker } from "./workers/briefing.worker";
import { startRecurringWorker, stopRecurringWorker } from "./workers/recurring.worker";
import { registerBriefingSchedule } from "./queues/briefing.queue";
import { registerRecurringSchedule } from "./queues/recurring.queue";

const PORT = process.env.PORT || 7100;

const startServer = async (): Promise<void> => {
  try {
    await connectRedis();
    initRateLimiters();
    logger.info("Redis connected");

    const pineconeReady = await initPinecone();
    if (pineconeReady) {
      logger.info("Pinecone initialized");
    } else {
      logger.warn("Pinecone unavailable; similar expenses and semantic search are disabled");
    }

    startParseWorkers();
    logger.info("Parse workers started");

    startBriefingWorker();
    await registerBriefingSchedule();
    logger.info("Briefing worker and weekly schedule registered");

    startRecurringWorker();
    await registerRecurringSchedule();
    logger.info("Recurring worker and hourly sweep registered");

    app.listen(PORT, () => {
      logger.info(
        { port: PORT, env: process.env.NODE_ENV || "development" },
        "Server running"
      );
    });
  } catch (error) {
    logger.fatal({ err: error }, "Failed to start server");
    Sentry.captureException(error);
    await Sentry.flush(2000);
    process.exit(1);
  }
};

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, closing HTTP server");
  Promise.allSettled([stopParseWorkers(), stopBriefingWorker(), stopRecurringWorker()]).finally(() =>
    process.exit(0)
  );
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, closing HTTP server");
  Promise.allSettled([stopParseWorkers(), stopBriefingWorker(), stopRecurringWorker()]).finally(() =>
    process.exit(0)
  );
});

startServer();
