/**
 * Turning "one piece" into something that catches how stores actually write it.
 *
 * Product titles are inconsistent in exactly a few ways: casing varies, the
 * separator between words is a space, a hyphen, or nothing at all, and popular
 * lines get abbreviated to their initials. So "one piece" has to find "One
 * Piece", "OnePiece", "one-piece" and "OP" alike.
 *
 * What it must *not* do is match inside a longer word. "OP" appearing in
 * "Optic" or "Topps" is not a One Piece product, and this feature sends texts —
 * a false positive costs someone a message they didn't ask for, at whatever
 * hour it fires. Every alternative is therefore bounded by "not adjacent to
 * another letter or digit".
 */

// Terms come from a text field, so they are escaped before they ever reach the
// RegExp constructor. Without this, typing "(" would throw and a "*" would turn
// one person's alert into a match on everything.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_TERMS = 12;
// Long enough for a real product title, which is what a watched item armed for
// buying contributes.
const MAX_TERM_LENGTH = 160;

/**
 * Shorten a term without splitting a word.
 *
 * Cutting mid-token silently breaks the match rather than narrowing it: a term
 * ending "…[991" demands that "991" be followed by a non-alphanumeric, and in
 * the title it is followed by more digits, so it matches nothing at all. Cutting
 * at a separator leaves a shorter phrase that still matches what it names.
 */
function clampTerm(term) {
  if (term.length <= MAX_TERM_LENGTH) return term;
  const cut = term.slice(0, MAX_TERM_LENGTH);
  const lastBreak = cut.search(/[^a-z0-9]+[a-z0-9]*$/i);
  return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trim();
}

/**
 * Strip accents, so "pokemon" finds "Pokémon". Stores are inconsistent about
 * whether they write the accent, and someone typing the alert on a phone
 * keyboard almost never does.
 */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Split what someone typed into separate terms. Commas and newlines separate;
 * "one piece, pokemon" is two alerts, not one phrase.
 */
export function parseTerms(input) {
  return [
    ...new Set(
      String(input ?? '')
        .split(/[,\n]/)
        .map((term) => fold(term).trim())
        .filter(Boolean)
        .map(clampTerm)
        .filter(Boolean),
    ),
  ].slice(0, MAX_TERMS);
}

/** The alphanumeric runs of a term: "one-piece!" -> ["one", "piece"]. */
function wordsOf(term) {
  return term.split(/[^a-z0-9]+/i).filter(Boolean);
}

// "Not preceded/followed by another word character." \b won't do here: the
// patterns are built by joining across separators, and \b would happily match
// the "op" inside "topps".
const LEFT = '(?<![a-z0-9])';
const RIGHT = '(?![a-z0-9])';

function alternativesFor(term) {
  const words = wordsOf(term);
  if (!words.length) return [];

  const alternatives = [];

  // The phrase itself, indifferent to what sits between the words — which
  // covers "one piece", "one-piece" and "onepiece" in one pattern.
  alternatives.push(`${LEFT}${words.map(escapeRegExp).join('[^a-z0-9]*')}${RIGHT}`);

  // The initialism, for multi-word terms whose words are real words. Single
  // letters are already initials, and a term like "a b" would produce "ab" —
  // two characters that appear inside half the catalogue.
  //
  // Only when every word is alphabetic. A term like "OP-17" is already the
  // specific thing being asked for, and taking its initials produced "o1",
  // which matched unrelated products — the opposite of what naming an exact
  // set code is for.
  const alphabetic = words.every((w) => /^[a-z]+$/.test(w) && w.length >= 2);
  if (words.length >= 2 && alphabetic) {
    const initials = words.map((w) => w[0]).join('');
    if (initials.length >= 2) alternatives.push(`${LEFT}${escapeRegExp(initials)}${RIGHT}`);
  }

  return alternatives;
}

/**
 * Compile someone's alert once, then test many titles against it. Returns null
 * when there is nothing to match, so callers treat "no alert set" and "alert set
 * to whitespace" the same way.
 *
 * A poll compares every event against every subscriber's alert, so the regex is
 * built once here rather than rebuilt per title.
 */
export function compileAlert(input) {
  const terms = parseTerms(input)
    .map((term) => ({ term, alternatives: alternativesFor(term) }))
    .filter((t) => t.alternatives.length);
  if (!terms.length) return null;

  const all = new RegExp(terms.flatMap((t) => t.alternatives).join('|'), 'i');
  const perTerm = terms.map((t) => ({ term: t.term, re: new RegExp(t.alternatives.join('|'), 'i') }));

  return {
    terms: terms.map((t) => t.term),
    /** Whether this alert matches a product title. */
    test: (text) => all.test(fold(text)),
    /** Which term matched, so the text message can say what it was for. */
    match: (text) => {
      const folded = fold(text);
      return perTerm.find(({ re }) => re.test(folded))?.term ?? null;
    },
  };
}

/** One-shot convenience for callers testing a single title. */
export function matchesKeyword(input, text) {
  return compileAlert(input)?.test(text) ?? false;
}

/** Which term matched, or null. */
export function matchedTerm(input, text) {
  return compileAlert(input)?.match(text) ?? null;
}
