/**
 * The table's optional chat filter: masks common English swear words and
 * slurs. Whole words only, so ordinary words that contain one ("Scunthorpe",
 * "cocktail", "assistant") pass. A light touch for a friends' game, not a
 * moderation system.
 */

/** Word stems; each may take the usual endings (s, es, ed, er, ers, ing, y). */
const STEMS = [
  'fuck',
  'fucker',
  'motherfuck',
  'motherfucker',
  'shit',
  'bullshit',
  'bitch',
  'cunt',
  'asshole',
  'arsehole',
  'bastard',
  'dick',
  'dickhead',
  'cock',
  'cocksucker',
  'pussy',
  'pussies',
  'slut',
  'whore',
  'twat',
  'wanker',
  'prick',
  'fag',
  'faggot',
  'retard',
  'nigger',
  'nigga',
  'spic',
  'kike',
  'chink',
];

const ENDINGS = '(?:s|es|ed|er|ers|ing|in|y|ty)?';

/** Letters may be repeated for emphasis ("fuuuck"). */
const stretch = (word: string) => [...word].map((c) => `${c}+`).join('');

const PATTERN = new RegExp(`\\b(?:${STEMS.map(stretch).join('|')})${ENDINGS}\\b`, 'gi');

/** The text with each listed word replaced by asterisks of the same length. */
export function maskProfanity(text: string): string {
  return text.replace(PATTERN, (word) => '*'.repeat(word.length));
}
