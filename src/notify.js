import twilio from 'twilio';
import { config } from './config.js';
import { query } from './db.js';
import { formatPrice } from './money.js';

let client = null;
let clientError = null;
if (config.twilio.enabled) {
  try {
    client = twilio(config.twilio.accountSid, config.twilio.authToken);
  } catch (err) {
    // The SDK throws on a malformed Account SID. That must not take the whole
    // process down at import — a mistyped variable would become an unbootable
    // deploy with a stack trace instead of a fixable error message.
    clientError = err.message;
    console.error(
      `[sms] Twilio client could not be created: ${err.message}. ` +
        'Check TWILIO_ACCOUNT_SID. Texts are disabled until this is fixed.',
    );
  }
}

export function twilioClientError() {
  return clientError;
}

/**
 * Send one SMS. Returns { ok, sid, error } rather than throwing, because a
 * single bad number must not abort a batch of notifications.
 */
export async function sendSms(to, body) {
  if (clientError) {
    return { ok: false, sid: null, error: `Twilio is misconfigured: ${clientError}`, code: null };
  }
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
    console.error(
      `[sms] failed to ${to}: [${err?.code ?? 'no code'}] ${err.message}` +
        (err?.moreInfo ? ` (${err.moreInfo})` : ''),
    );
    return { ok: false, sid: null, error: err.message, code: err?.code };
  }
}

/**
 * Turn a Twilio error code into something the person staring at the dialog can
 * act on. Twilio's own message is written for the account owner reading API
 * docs, not for someone who just typed their phone number in.
 *
 * `status` is the HTTP code to answer with: 400 when the recipient is the
 * problem, 500 when the Twilio account or its configuration is.
 */
const TWILIO_ERRORS = {
  20003: {
    status: 500,
    message:
      'Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
  },
  21211: { status: 400, message: 'Twilio does not recognise that phone number.' },
  21408: {
    status: 500,
    message:
      'This Twilio account is not enabled for sending to that country. Enable the region ' +
      'under Messaging → Geo permissions.',
  },
  21606: {
    status: 500,
    message:
      'TWILIO_FROM_NUMBER is not a number on this account, or cannot send SMS. Use an ' +
      'SMS-capable Twilio number in E.164 form, e.g. +15551234567.',
  },
  21610: {
    status: 400,
    message: 'That number replied STOP to an earlier message. Text START to the same number to opt back in.',
  },
  21612: {
    status: 500,
    message: 'Twilio cannot route from your number to that one. Try a Messaging Service instead.',
  },
  21614: { status: 400, message: 'That number cannot receive SMS — it looks like a landline.' },
  21659: {
    status: 500,
    message:
      'TWILIO_FROM_NUMBER is not a valid sending number for this account. Check it matches a ' +
      'number you own, in E.164 form.',
  },
  63038: {
    status: 500,
    message: 'This Twilio account has hit its daily message limit.',
  },
};

// Trial accounts refuse any destination that has not been verified in the
// console. It is the single most common first-run failure, so it gets the
// longest explanation.
const TRIAL_UNVERIFIED = {
  status: 400,
  message:
    'This is a Twilio trial account, which can only text numbers you have verified. ' +
    'Add this number under Phone Numbers → Verified Caller IDs in the Twilio console, ' +
    'or upgrade the account.',
};

export function describeSmsFailure(result) {
  if (result.code === 21608) return TRIAL_UNVERIFIED;
  const known = TWILIO_ERRORS[result.code];
  if (known) return known;

  // Unmapped: pass Twilio's own text through rather than hiding it, with the
  // code so it can be looked up.
  return {
    status: 500,
    message: result.code
      ? `Twilio error ${result.code}: ${result.error}`
      : (result.error ?? 'The text could not be sent.'),
  };
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

/**
 * A product matched someone's standing alert. It says which term matched and
 * whether the thing can be bought right now, because unlike a watchlist alert
 * the recipient has never seen this product before and has no context for it.
 */
export function keywordMessage(event, feedToken, currency = 'USD', term = null) {
  const formatted = formatPrice(event.price, currency);
  const price = formatted ? ` — ${formatted}` : '';
  const lead = event.type === 'restock' ? 'IN STOCK' : 'NEW';
  const because = term ? ` (matched "${truncate(term, 30)}")` : '';
  return (
    `${lead}: ${truncate(event.title, 80)}${price}${because}\n` +
    `${event.url}\n\n` +
    `Manage alerts: ${config.publicUrl}/?t=${feedToken}\nReply STOP to end.`
  );
}

function truncate(str, max) {
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}
