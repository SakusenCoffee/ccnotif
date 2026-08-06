import twilio from 'twilio';
import { config } from './config.js';

/**
 * Ask Twilio what is actually wrong, rather than inferring it from a failed
 * send. Checks the credentials, whether the sending number is one this account
 * owns and can send SMS from, and — on a trial account — which destinations are
 * allowed. Returns findings, never secrets.
 */
export async function diagnoseTwilio() {
  const report = {
    configured: config.twilio.enabled,
    checks: [],
    problems: [],
    account: null,
    fromNumber: null,
    sendableTo: null,
  };

  const add = (ok, label, detail) => report.checks.push({ ok, label, detail });
  const problem = (message, fix) => report.problems.push({ message, fix });

  // --- shape of the variables, before spending a network call ---------------
  const sid = config.twilio.accountSid ?? '';
  const token = config.twilio.authToken ?? '';
  const from = config.twilio.from ?? '';
  const serviceSid = config.twilio.messagingServiceSid ?? '';

  if (!sid) {
    problem('TWILIO_ACCOUNT_SID is not set.', 'Copy it from the Twilio console dashboard.');
  } else if (!/^AC[0-9a-f]{32}$/i.test(sid)) {
    problem(
      `TWILIO_ACCOUNT_SID does not look like an Account SID (got ${sid.length} chars starting "${sid.slice(0, 2)}").`,
      'It starts with AC and is 34 characters. Check for quotes or whitespace pasted in with it.',
    );
  } else {
    add(true, 'TWILIO_ACCOUNT_SID looks well formed', `${sid.slice(0, 6)}…${sid.slice(-4)}`);
  }

  if (!token) {
    problem('TWILIO_AUTH_TOKEN is not set.', 'Copy it from the Twilio console dashboard.');
  } else if (token.length !== 32) {
    problem(
      `TWILIO_AUTH_TOKEN is ${token.length} characters; Twilio's is 32.`,
      'A common cause is quotes or a trailing space included in the variable value.',
    );
  } else {
    add(true, 'TWILIO_AUTH_TOKEN looks well formed', '32 characters');
  }

  if (!from && !serviceSid) {
    problem(
      'Neither TWILIO_FROM_NUMBER nor TWILIO_MESSAGING_SERVICE_SID is set.',
      'Set TWILIO_FROM_NUMBER to your Twilio number in E.164 form, e.g. +15551234567.',
    );
  }
  if (from && !/^\+[1-9]\d{6,14}$/.test(from)) {
    problem(
      `TWILIO_FROM_NUMBER "${from}" is not in E.164 form.`,
      'It must start with + and a country code, digits only — e.g. +15551234567.',
    );
  }
  if (serviceSid && !/^MG[0-9a-f]{32}$/i.test(serviceSid)) {
    problem(
      'TWILIO_MESSAGING_SERVICE_SID is set but does not look like a Messaging Service SID.',
      'It starts with MG. Clear the variable if you are not using a Messaging Service — ' +
        'when set, it overrides TWILIO_FROM_NUMBER.',
    );
  }

  if (!report.configured) {
    problem(
      'Twilio is not fully configured, so the app is in dry-run mode: it pretends the ' +
        'text was sent and prints it to the logs instead.',
      'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER, then redeploy.',
    );
    return report;
  }

  // --- talk to Twilio -------------------------------------------------------
  let client;
  try {
    client = twilio(sid, token);
  } catch (err) {
    problem(
      `Twilio client could not be created: ${err.message}`,
      'Check TWILIO_ACCOUNT_SID — it must start with AC and be 34 characters.',
    );
    return report;
  }

  try {
    const account = await client.api.v2010.accounts(sid).fetch();
    report.account = { friendlyName: account.friendlyName, status: account.status, type: account.type };
    add(true, 'Credentials accepted by Twilio', `${account.type} account, status ${account.status}`);

    if (account.status !== 'active') {
      problem(
        `The Twilio account is ${account.status}, not active.`,
        'Check for a suspended account or an unpaid balance in the console.',
      );
    }
  } catch (err) {
    problem(
      `Twilio rejected the credentials (${err.code ?? 'no code'}: ${err.message}).`,
      'Re-copy the Account SID and Auth Token. Make sure no quotes were included.',
    );
    return report; // nothing else will work
  }

  // Is the sending number one we own, and can it send SMS?
  if (from) {
    try {
      const owned = await client.incomingPhoneNumbers.list({ limit: 50 });
      const match = owned.find((n) => n.phoneNumber === from);
      report.fromNumber = {
        configured: from,
        owned: Boolean(match),
        smsCapable: match ? Boolean(match.capabilities?.sms) : null,
        numbersOnAccount: owned.map((n) => ({
          number: n.phoneNumber,
          sms: Boolean(n.capabilities?.sms),
        })),
      };

      if (!owned.length) {
        problem(
          'This Twilio account owns no phone numbers.',
          'Get one under Phone Numbers → Manage → Buy a number (trial accounts get one free), ' +
            'then set TWILIO_FROM_NUMBER to it.',
        );
      } else if (!match) {
        problem(
          `TWILIO_FROM_NUMBER (${from}) is not a number on this account.`,
          `Numbers you own: ${owned.map((n) => n.phoneNumber).join(', ')}. Set the variable to one of them.`,
        );
      } else if (!match.capabilities?.sms) {
        problem(
          `${from} cannot send SMS.`,
          'Pick a number whose capabilities include SMS.',
        );
      } else {
        add(true, 'Sending number is owned and SMS-capable', from);
      }
    } catch (err) {
      problem(`Could not list this account's phone numbers: ${err.message}`, 'Retry in a moment.');
    }
  }

  if (serviceSid) {
    try {
      const service = await client.messaging.v1.services(serviceSid).fetch();
      add(true, 'Messaging Service found', service.friendlyName);
    } catch (err) {
      problem(
        `TWILIO_MESSAGING_SERVICE_SID is set but Twilio could not fetch it: ${err.message}`,
        'Clear the variable to fall back to TWILIO_FROM_NUMBER.',
      );
    }
  }

  // Trial accounts can only reach verified numbers, so list them explicitly.
  if (report.account?.type === 'Trial') {
    try {
      const verified = await client.outgoingCallerIds.list({ limit: 50 });
      report.sendableTo = verified.map((v) => v.phoneNumber);
      if (!verified.length) {
        problem(
          'This is a trial account with no verified caller IDs, so it can text nobody.',
          'Verify a number under Phone Numbers → Manage → Verified Caller IDs.',
        );
      } else {
        add(
          true,
          'Trial account — texts can only go to these verified numbers',
          verified.map((v) => v.phoneNumber).join(', '),
        );
      }
    } catch (err) {
      problem(`Could not list verified caller IDs: ${err.message}`, 'Retry in a moment.');
    }
  }

  return report;
}
