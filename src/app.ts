import path from "path";
import express, { Express, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import * as Sentry from "@sentry/node";

import { aiRateLimit, generalRateLimit } from "./middleware/rateLimit";
import { httpLogger } from "./config/logger";
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

const app: Express = express();

app.set("trust proxy", true);

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

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(compression());

app.use(httpLogger);

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

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

app.use("/api/auth", authRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/insights", insightRoutes);
app.use("/api/budgets", budgetRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/assistant", assistantRoutes);
app.use("/api/goals", goalRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/recurring", recurringRuleRoutes);

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

export { app };
