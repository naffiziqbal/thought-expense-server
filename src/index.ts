import "./instrument";
import path from "path";
import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import * as Sentry from "@sentry/node";

import { connectRedis } from "./config/redis";
import { aiRateLimit, generalRateLimit, initRateLimiters } from "./middleware/rateLimit";
import { httpLogger, logger } from "./config/logger";
import { initPinecone } from "./services/pinecone.service";
import authRoutes from "./routes/auth.routes";
import expenseRoutes from "./routes/expense.routes";
import insightRoutes from "./routes/insight.routes";
import budgetRoutes from "./routes/budget.routes";
import billingRoutes from "./routes/billing.routes";
import assistantRoutes from "./routes/assistant.routes";
import goalRoutes from "./routes/goal.routes";
import notificationRoutes from "./routes/notification.routes";
import recurringRuleRoutes from "./routes/recurringRule.routes";
import { errorHandler } from "./middleware/error.middleware";
import { startParseWorkers, stopParseWorkers } from "./workers/parse.worker";
import { startBriefingWorker, stopBriefingWorker } from "./workers/briefing.worker";
import { startRecurringWorker, stopRecurringWorker } from "./workers/recurring.worker";
import { registerBriefingSchedule } from "./queues/briefing.queue";
import { registerRecurringSchedule } from "./queues/recurring.queue";

const app = express();
const PORT = process.env.PORT || 7100;

app.set("trust proxy", true);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Rate limiting — Redis-backed after initRateLimiters() (see startServer).
// Keyed by JWT user id when present, else IP. AI routes are tighter.
app.use("/api/expenses/parse", aiRateLimit);
app.use("/api/expenses/ocr", aiRateLimit);
app.use("/api/assistant", aiRateLimit);
app.use("/api/insights/generate", aiRateLimit);
app.use("/api/insights/briefing/generate", aiRateLimit);
app.use("/api", generalRateLimit);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Compression middleware
app.use(compression());

app.use(httpLogger);

// Serve uploaded files (local storage fallback when Spaces not configured)
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

if (process.env.NODE_ENV !== "production") {
  app.get("/debug-sentry", () => {
    Sentry.logger.info("User triggered test error", {
      action: "test_error_endpoint",
    });
    Sentry.metrics.count("test_counter", 1);
    throw new Error("My first Sentry error!");
  });
}

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/insights", insightRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/goals", goalRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/recurring", recurringRuleRoutes);

// 404 handler
app.use("*", (_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

Sentry.setupExpressErrorHandler(app, {
  shouldHandleError(error) {
    const status =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : undefined;
    return status == null || status >= 500;
  },
});

app.use(errorHandler);

// Initialize connections and start server
const startServer = async (): Promise<void> => {
  try {
    // Connect to Redis
    await connectRedis();
    initRateLimiters();
    logger.info("Redis connected");

    // Initialize Pinecone
    await initPinecone();
    logger.info("Pinecone initialized");

    // Start background workers
    startParseWorkers();
    logger.info("Parse workers started");

    // Weekly financial briefing (worker + cron schedule)
    startBriefingWorker();
    await registerBriefingSchedule();
    logger.info("Briefing worker and weekly schedule registered");

    // Auto-logged recurring expenses (hourly sweep)
    startRecurringWorker();
    await registerRecurringSchedule();
    logger.info("Recurring worker and hourly sweep registered");

    // Start server
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

// Graceful shutdown
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
