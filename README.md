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

## Configuration

See `.env.example`. Texting is optional — with no SMS credentials set, messages
are written to the log instead of sent.

## Notes

Private project, not accepting contributions.
