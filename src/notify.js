import twilio from 'twilio';
import { config } from './config.js';
import { query } from './db.js';
import { formatPrice } from './money.js';

let client = null;
if (config.twilio.enabled) {
  client = twilio(config.twilio.accountSid, config.twilio.authToken);
}

/**
 * Send one SMS. Returns { ok, sid, error } rather than throwing, because a
 * single bad number must not abort a batch of notifications.
 */
export async function sendSms(to, body) {
  if (!client) {
    console.log(`[sms:dry-run] -> ${to}\n${body}\n`);
    return { ok: true, sid: null, dryRun: true };
  }

  const payload = { to, body };
  if (config.twilio.messagingServiceSid) {
    payload.messagingServiceSid = config.twilio.messagingServiceSid;
  } else {
    payload.from = config.twilio.from;
  }

  try {
    const message = await client.messages.create(payload);
    return { ok: true, sid: message.sid };
  } catch (err) {
    // 21610 is Twilio's "recipient has replied STOP" code. Record the opt-out
    // so the poller stops trying on every future restock.
    if (err?.code === 21610) {
      await query(
        `update subscribers set unsubscribed_at = now() where phone = $1 and unsubscribed_at is null`,
        [to],
      ).catch(() => {});
    }
    console.error(`[sms] failed to ${to}: ${err.message}`);
    return { ok: false, sid: null, error: err.message, code: err?.code };
  }
}

export function verificationMessage(code) {
  return (
    `${code} is your ${config.appName} code. ` +
    `It expires in ${config.verification.codeTtlMinutes} minutes.`
  );
}

export function restockMessage(event, feedToken, currency = 'USD') {
  const formatted = formatPrice(event.price, currency);
  const price = formatted ? ` — ${formatted}` : '';
  const manageUrl = `${config.publicUrl}/?t=${feedToken}`;
  return (
    `IN STOCK: ${truncate(event.title, 90)}${price}\n` +
    `${event.url}\n\n` +
    `Manage alerts: ${manageUrl}\nReply STOP to end.`
  );
}

function truncate(str, max) {
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}
