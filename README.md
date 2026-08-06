# Pre-Order Watch

Personal restock notifier. Tracks products across storefronts you configure and
sends a text when one becomes buyable, with an RSS feed of the same events.

## Running it

Requires Node 20+ and Postgres.

```bash
npm install
cp .env.example .env     # set DATABASE_URL
npm run migrate
npm start
```

`npm run poll` does a single polling pass and exits.

## Accounts

The site requires a login and has no sign-up page. Create accounts from the
command line:

```bash
npm run useradd <username> [password]     # password is generated if omitted
npm run useradd -- --list
npm run useradd -- --passwd <username>    # reset
npm run useradd -- --delete <username>
```

On a fresh deploy there is no account yet and therefore no way in. Set
`ADMIN_USERNAME` and `ADMIN_PASSWORD`, start the app, sign in, then clear them.

## Notifications

Two channels, either or both:

- **Push (free)** — through [ntfy](https://ntfy.sh). No account, no per-message
  cost, no phone number. Turn it on under Account and subscribe to the topic
  shown in the ntfy app. Topics are generated rather than chosen, because on a
  public server anyone who knows a topic name can read it.
- **SMS** — off unless `SMS_ENABLED=true`, and then it needs Twilio credentials
  and costs per message. While it is off the phone fields are hidden and the
  verification endpoints refuse outright, so a half-finished Twilio setup cannot
  surface as errors in a UI nobody asked to use.

With neither configured, messages are written to the log instead of sent.

## Configuration

See `.env.example`.

## Notes

Private project, not accepting contributions.
