import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '../src/config/prisma';
import { escapeHtml, formatAlert, sendAlert } from '../src/services/alerts.service';
import { checkDatabase, checkWebhookErrors } from '../src/services/opsMonitor.service';

const env = { ...process.env };
const eventIds: string[] = [];

afterAll(async () => {
  await prisma.billingWebhookEvent.deleteMany({ where: { externalEventId: { in: eventIds } } });
  await prisma.$disconnect();
});

describe('alert formatting', () => {
  it('escapes HTML so user-controlled text cannot break the message', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    const html = formatAlert('🚨', 'Webhook <crashed>', ['reason: a < b']);
    expect(html).toContain('<b>Webhook &lt;crashed&gt;</b>');
    expect(html).toContain('reason: a &lt; b');
  });
});

describe('sendAlert', () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));

  beforeEach(() => {
    // Alerts are disabled under NODE_ENV=test; enable them with a fake bot for this block.
    process.env.NODE_ENV = 'production';
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_ALERT_CHAT_ID = '42';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it('sends once per cooldown window for the same key', async () => {
    const key = `test-${Date.now()}`;
    await sendAlert(key, { severity: 'critical', title: 'Something broke' });
    await sendAlert(key, { severity: 'critical', title: 'Something broke' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe('42');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('Something broke');
  });

  it('does nothing when Telegram is not configured', async () => {
    delete process.env.TELEGRAM_ALERT_CHAT_ID;
    await sendAlert(`unconfigured-${Date.now()}`, { severity: 'info', title: 'x' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when Telegram is down', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(
      sendAlert(`down-${Date.now()}`, { severity: 'warning', title: 'x' })
    ).resolves.toBeUndefined();
  });
});

// Individual checks only: CI has no Redis, and the queue/AI checks need it.
describe('ops checks', () => {
  it('fires webhook_errors when a webhook failed recently', async () => {
    const id = `alert-test-${Date.now()}`;
    eventIds.push(id);
    await prisma.billingWebhookEvent.create({
      data: { externalEventId: id, eventType: 'RENEWAL', outcome: 'error' },
    });

    const check = await checkWebhookErrors();
    expect(check.firing).toBe(true);
    expect(check.message.lines?.join(' ')).toContain('RENEWAL');
  });

  it('reports the database as healthy', async () => {
    expect((await checkDatabase()).firing).toBe(false);
  });
});
