import type { GameSpec } from '../core/types';

export type VariantId =
  | 'nlhe'
  | 'plo4'
  | 'plo5'
  | 'plo6'
  | 'plo8'
  | 'plo5-8'
  | 'plo6-8'
  | 'stud'
  | 'razz'
  | 'stud8'
  | 'td27'
  | 'badugi';

/** How the high half is judged. */
export type HighRule = 'any-five' | 'omaha';
/** How the low half is judged. */
export type LowRule = 'ace-to-five' | 'eight-or-better' | 'omaha-eight-or-better' | 'deuce-to-seven' | 'badugi';

/** Everything the engine, the lobby and the rules panel need about one game. Plain JSON. */
export interface VariantSpec extends GameSpec {
  id: VariantId;
  /** Felt and lobby label, e.g. "PLO8". */
  shortName: string;
  /** Private plus face-up cards each player ends with (2 Hold'em, 7 stud, 5 triple draw). */
  cardsPerPlayer: number;
  showdown: { high?: HighRule; low?: LowRule };
  /** A few sentences for the in-game rules panel. */
  rules: string;
}
