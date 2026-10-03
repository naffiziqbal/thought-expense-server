/**
 * AI financial advisor built on Gemini. Unlike the old insight prompt, the
 * advisor is deliberately prescriptive: it explains WHY spending changed and
 * proposes realistic, numbers-grounded ways to save.
 */

import { runInsightsModel, extractJson } from './gemini.service';
import type { AiMetricKind } from './aiMetrics.service';
import { SpendingIntelligence } from './analytics.service';

export interface AdvisorContext {
  currency: string;
  currentMonth: {
    month: string; // YYYY-MM
    total: number;
    byCategory: Record<string, number>;
    transactionCount: number;
  };
  previousMonth?: {
    month: string;
    total: number;
    byCategory: Record<string, number>;
  };
  budget?: {
    totalLimit: number;
    totalSpent: number;
    remaining: number;
  } | null;
  goals?: Array<{
    name: string;
    targetAmount: number;
    savedAmount: number;
    deadline?: string | null;
  }>;
  intelligence?: Pick<SpendingIntelligence, 'anomalies' | 'trends' | 'waste' | 'recurring'>;
  topExpenses?: Array<{ description: string; category: string; amount: number; date: string }>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AdvisorAnswer {
  answer: string;
  followUps: string[];
}

export interface SavingsPlanStep {
  category: string;
  action: string;
  estimatedMonthlySaving: number;
}

export interface SavingsPlan {
  feasible: boolean;
  targetAmount: number;
  currency: string;
  estimatedTotalSaving: number;
  summary: string;
  steps: SavingsPlanStep[];
}

export interface BriefingContent {
  title: string;
  summary: string;
  highlights: string[]; // biggest changes, unusual expenses, trends
  recommendations: string[]; // 1-2 actionable recommendations
}

const ADVISOR_PERSONA = `You are the financial advisor inside "Thought Expenses", a personal finance app.
You have the user's REAL spending data below. Your job: help them understand their money and spend it better.

RULES:
- Every claim must be grounded in the data provided. Quote real amounts with the currency. NEVER invent numbers.
- Be prescriptive and concrete: "Cutting X to twice a week saves ~Y/month", not "consider spending less".
- Be honest but kind. No lectures, no filler, no disclaimers about being an AI.
- If the data cannot answer the question, say exactly what is missing and suggest what to track.
- Keep answers tight: a few sentences or a short list. The user is on a phone.
- Amounts in the data are already converted to the user's currency.`;

function contextBlock(ctx: AdvisorContext): string {
  const lines: string[] = [];
  lines.push(`Currency: ${ctx.currency}`);
  lines.push(
    `Current month (${ctx.currentMonth.month}): total ${ctx.currentMonth.total}, ${ctx.currentMonth.transactionCount} transactions`
  );
  lines.push(`  By category: ${JSON.stringify(ctx.currentMonth.byCategory)}`);

  if (ctx.previousMonth) {
    lines.push(`Previous month (${ctx.previousMonth.month}): total ${ctx.previousMonth.total}`);
    lines.push(`  By category: ${JSON.stringify(ctx.previousMonth.byCategory)}`);
    const deltas: string[] = [];
    const cats = new Set([
      ...Object.keys(ctx.currentMonth.byCategory),
      ...Object.keys(ctx.previousMonth.byCategory),
    ]);
    for (const c of cats) {
      const cur = ctx.currentMonth.byCategory[c] || 0;
      const prev = ctx.previousMonth.byCategory[c] || 0;
      if (prev === 0 && cur === 0) continue;
      const diff = Math.round((cur - prev) * 100) / 100;
      const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
      deltas.push(
        `${c}: ${diff >= 0 ? '+' : ''}${diff}${pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct}%)` : ' (new)'}`
      );
    }
    lines.push(`  Month-over-month category changes: ${deltas.join('; ')}`);
  }

  if (ctx.budget) {
    lines.push(
      `Budget this month: limit ${ctx.budget.totalLimit}, spent ${ctx.budget.totalSpent}, remaining ${ctx.budget.remaining}`
    );
  }
  if (ctx.goals && ctx.goals.length > 0) {
    lines.push(
      `Savings goals: ${ctx.goals
        .map(
          (g) =>
            `"${g.name}" ${g.savedAmount}/${g.targetAmount}${g.deadline ? ` by ${g.deadline.slice(0, 10)}` : ''}`
        )
        .join('; ')}`
    );
  }
  if (ctx.intelligence) {
    const { anomalies, trends, waste, recurring } = ctx.intelligence;
    if (anomalies.length)
      lines.push(`Detected anomalies: ${anomalies.map((a) => a.message).join(' | ')}`);
    if (trends.length) lines.push(`Rising categories: ${trends.map((t) => t.message).join(' | ')}`);
    if (waste.length) lines.push(`Potential waste: ${waste.map((w) => w.message).join(' | ')}`);
    if (recurring.length)
      lines.push(
        `Recurring expenses: ${recurring.map((r) => `${r.description} ~${r.averageAmount}/month`).join('; ')}`
      );
  }
  if (ctx.topExpenses && ctx.topExpenses.length > 0) {
    lines.push(
      `Largest recent expenses: ${ctx.topExpenses
        .map((e) => `${e.description} (${e.category}) ${e.amount} on ${e.date.slice(0, 10)}`)
        .join('; ')}`
    );
  }
  return lines.join('\n');
}

/**
 * Free-form Q&A over the user's finances ("chat with your money").
 * ragMatches carries semantically similar past expenses for history questions.
 */
export async function answerFinancialQuestion(
  question: string,
  ctx: AdvisorContext,
  ragMatches: Array<{
    description: string;
    category: string;
    amount: number;
    currency: string;
    date: string;
  }> = [],
  history: ChatMessage[] = [],
  metricKind: AiMetricKind = 'advisor_ask'
): Promise<AdvisorAnswer> {
  const historyBlock = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Advisor'}: ${m.content}`)
    .join('\n');

  const ragBlock =
    ragMatches.length > 0
      ? `\nEXPENSES FROM HISTORY MOST RELEVANT TO THE QUESTION:\n${ragMatches
          .map(
            (m) =>
              `- ${m.description} (${m.category}): ${m.amount} ${m.currency} on ${m.date.slice(0, 10)}`
          )
          .join('\n')}\n`
      : '';

  const prompt = `${ADVISOR_PERSONA}

USER'S FINANCIAL DATA:
${contextBlock(ctx)}
${ragBlock}
${historyBlock ? `CONVERSATION SO FAR:\n${historyBlock}\n` : ''}
USER'S QUESTION: "${question}"

Answer the question using the data. Then suggest up to 2 natural follow-up questions the user might ask next.

Return JSON:
{
  "answer": "your answer (plain text, short paragraphs or a short list)",
  "followUps": ["follow-up question 1", "follow-up question 2"]
}`;

  const raw = await runInsightsModel(prompt, metricKind);
  try {
    const parsed = extractJson(raw);
    return {
      answer: String(parsed.answer || raw).trim(),
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps.map(String).slice(0, 2) : [],
    };
  } catch {
    // Model answered in plain text — still a valid answer
    return { answer: raw.trim(), followUps: [] };
  }
}

/**
 * "Why did I spend so much this month?" — a concrete, data-backed explanation.
 */
export async function explainSpendingChange(ctx: AdvisorContext): Promise<AdvisorAnswer> {
  return answerFinancialQuestion(
    'Why did I spend so much this month? Explain exactly what drove the change compared to last month, naming the categories and purchases responsible.',
    ctx,
    [],
    [],
    'advisor_why'
  );
}

/**
 * "How can I save X next month?" — a realistic plan from actual spending.
 */
export async function generateSavingsPlan(
  ctx: AdvisorContext,
  targetAmount: number
): Promise<SavingsPlan> {
  const prompt = `${ADVISOR_PERSONA}

USER'S FINANCIAL DATA:
${contextBlock(ctx)}

The user wants to save ${targetAmount} ${ctx.currency} next month.

Build a REALISTIC savings plan from their actual spending:
- Only cut from categories they actually spend on, and never suggest cutting essentials (rent, utilities, medicine) below what they cost.
- Prefer trimming detected waste, overlapping subscriptions and discretionary categories first.
- Each step: a category, one concrete action, and a realistic monthly saving estimate.
- If the target is not realistically reachable, say so honestly, set "feasible" false, and plan for the amount that IS reachable.

Return JSON:
{
  "feasible": true,
  "summary": "one-or-two-sentence overview of the plan",
  "estimatedTotalSaving": 123,
  "steps": [
    { "category": "Category", "action": "concrete action", "estimatedMonthlySaving": 50 }
  ]
}`;

  const raw = await runInsightsModel(prompt, 'advisor_savings');
  const parsed = extractJson(raw);
  const steps: SavingsPlanStep[] = (Array.isArray(parsed.steps) ? parsed.steps : [])
    .map((s: any) => ({
      category: String(s.category || 'Other'),
      action: String(s.action || ''),
      estimatedMonthlySaving: Number(s.estimatedMonthlySaving) || 0,
    }))
    .filter((s: SavingsPlanStep) => s.action);

  return {
    feasible: parsed.feasible !== false,
    targetAmount,
    currency: ctx.currency,
    estimatedTotalSaving:
      Number(parsed.estimatedTotalSaving) ||
      Math.round(steps.reduce((a, b) => a + b.estimatedMonthlySaving, 0) * 100) / 100,
    summary: String(parsed.summary || '').trim(),
    steps,
  };
}

/**
 * Weekly briefing content: total, biggest changes, unusual expenses, trends,
 * savings progress, 1-2 recommendations.
 */
export async function generateBriefingContent(
  ctx: AdvisorContext,
  weekTotal: number,
  previousWeekTotal: number,
  weekByCategory: Record<string, number>
): Promise<BriefingContent> {
  const prompt = `${ADVISOR_PERSONA}

USER'S FINANCIAL DATA:
${contextBlock(ctx)}

THIS WEEK: total ${weekTotal} ${ctx.currency}, by category: ${JSON.stringify(weekByCategory)}
LAST WEEK: total ${previousWeekTotal} ${ctx.currency}

Write the user's WEEKLY FINANCIAL BRIEFING. It must cover, in this order of priority:
1. Total spent this week and how it compares to last week
2. The biggest changes and any unusual expenses (use the detected anomalies)
3. Trends worth knowing (use the rising categories / waste findings)
4. Savings/budget progress if goals or a budget exist
5. One or two actionable recommendations for next week, with estimated savings

Return JSON:
{
  "title": "short title, e.g. 'Your week: spending up 12%'",
  "summary": "2-3 sentence overview",
  "highlights": ["highlight 1", "highlight 2", "highlight 3"],
  "recommendations": ["recommendation 1", "recommendation 2"]
}`;

  const raw = await runInsightsModel(prompt, 'briefing');
  const parsed = extractJson(raw);
  return {
    title: String(parsed.title || 'Your weekly financial briefing').trim(),
    summary: String(parsed.summary || '').trim(),
    highlights: (Array.isArray(parsed.highlights) ? parsed.highlights : []).map(String).slice(0, 5),
    recommendations: (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
      .map(String)
      .slice(0, 2),
  };
}
