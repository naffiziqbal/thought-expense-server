import "./instrument";
import path from "path";
import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";

import { connectRedis } from "./config/redis";
import { httpLogger, logger } from "./config/logger";
import { initPinecone } from "./services/pinecone.service";
import authRoutes from "./routes/auth.routes";
import expenseRoutes from "./routes/expense.routes";
import insightRoutes from "./routes/insight.routes";
import budgetRoutes from "./routes/budget.routes";
import billingRoutes from "./routes/billing.routes";
import assistantRoutes from "./routes/assistant.routes";
import goalRoutes from "./routes/goal.routes";
import { errorHandler } from "./middleware/error.middleware";
import { startParseWorkers, stopParseWorkers } from "./workers/parse.worker";
import { startBriefingWorker, stopBriefingWorker } from "./workers/briefing.worker";
import { registerBriefingSchedule } from "./queues/briefing.queue";

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

// Rate limiting (production only).
// Keyed by the authenticated user (JWT subject) when present, falling back to
// IP — mobile users behind carrier-grade NAT share IPs, so per-IP buckets
// alone throttle innocent users. The JWT is not verified here (auth middleware
// does that); it is only used as a bucketing key.
const rateLimitKey = (req: Request): string => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = JSON.parse(
        Buffer.from(auth.split(" ")[1].split(".")[1], "base64url").toString("utf8")
      );
      if (payload?.id) return `user:${payload.id}`;
    } catch {
      // malformed token: fall through to IP
    }
  }
  return `ip:${req.ip}`;
};

if (process.env.NODE_ENV === "production") {
  // General API traffic: generous — normal screens fire several requests each
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    keyGenerator: rateLimitKey,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { success: false, message: "Too many requests. Please slow down and try again in a few minutes." },
  });

  // Expensive AI endpoints (Gemini-backed): tighter budget per user
  const aiLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    keyGenerator: rateLimitKey,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
    message: { success: false, message: "You're going a bit fast for our AI. Please wait a few minutes and try again." },
  });

  app.use("/api/expenses/parse", aiLimiter);
  app.use("/api/expenses/ocr", aiLimiter);
  app.use("/api/assistant", aiLimiter);
  app.use("/api/insights/generate", aiLimiter);
  app.use("/api/insights/briefing/generate", aiLimiter);
  app.use("/api", generalLimiter);
}

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
  Promise.allSettled([stopParseWorkers(), stopBriefingWorker()]).finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  logger.info("SIGINT received, closing HTTP server");
  Promise.allSettled([stopParseWorkers(), stopBriefingWorker()]).finally(() => process.exit(0));
});

startServer();
