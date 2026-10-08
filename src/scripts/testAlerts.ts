/**
 * Telegram alerts helper.
 *
 *   pnpm alerts:test            # send a test message to TELEGRAM_ALERT_CHAT_ID
 *   pnpm alerts:test --chat-id  # print chat ids that have messaged the bot (send it /start first)
 *   pnpm alerts:test --check    # evaluate ops checks and print them (no messages sent)
 */

import 'dotenv/config';
import { connectRedis, getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import { alertsEnabled, formatAlert, sendTelegramMessage } from '../services/alerts.service';
import { runOpsChecks } from '../services/opsMonitor.service';

async function printChatIds() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = (await res.json()) as {
    result?: Array<
      Record<string, { chat?: { id: number; type: string; title?: string; username?: string } }>
    >;
  };
  const chats = new Map<number, string>();
  for (const update of body.result ?? []) {
    for (const v of Object.values(update)) {
      const chat = typeof v === 'object' && v ? v.chat : undefined;
      if (chat) chats.set(chat.id, `${chat.type} ${chat.title ?? chat.username ?? ''}`.trim());
    }
  }
  if (chats.size === 0) {
    console.log(
      'No chats yet. Open @te_penny_bot in Telegram, press Start (or add it to a group), then re-run.'
    );
    return;
  }
  for (const [id, label] of chats) console.log(`TELEGRAM_ALERT_CHAT_ID=${id}   # ${label}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--chat-id')) return printChatIds();

  if (args.includes('--check')) {
    await connectRedis();
    const results = await runOpsChecks();
    for (const r of results) {
      console.log(
        `${r.firing ? 'FIRING' : 'ok    '}  ${r.key}${r.firing ? `  — ${r.message.title}` : ''}`
      );
      if (r.firing) for (const line of r.message.lines ?? []) console.log(`          ${line}`);
    }
    await getRedisClient().quit();
    return;
  }

  if (!alertsEnabled()) {
    throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID (see --chat-id).');
  }
  const ok = await sendTelegramMessage(
    formatAlert('👋', 'Penny is connected', ['Ops alerts for ThoughtExpense will arrive here.'])
  );
  console.log(ok ? 'Test alert sent.' : 'Sending failed — check the server log output above.');
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // BullMQ queues imported by the monitor hold Redis connections open.
    process.exit(process.exitCode ?? 0);
  });
