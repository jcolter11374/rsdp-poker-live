import { z } from 'zod';
import type { AnteType, BettingKind } from '../core/types';
import { isSectionEnabled, listModifierSchemas, parseModifierSections } from './modifiers';

/** Layout version stored in every settings object. Bump it with a new step in migrate.ts. */
export const SETTINGS_VERSION = 1;

/** Largest chip amount a setting may hold; ten such stacks still sum far inside safe integers. */
export const MAX_CHIPS = 1_000_000_000_000;

export const TABLE_MODES = ['cash', 'tournament'] as const;
export const BETTING_KINDS = ['no-limit', 'pot-limit', 'fixed-limit'] as const satisfies readonly BettingKind[];
export const ANTE_TYPES = ['none', 'per-player', 'big-blind'] as const satisfies readonly AnteType[];
export const ROTATION_UNITS = ['hands', 'orbits'] as const;
export const LEVEL_COUNTDOWNS = ['per-level-timer', 'hands'] as const;
export const RUN_IT_TWICE_OPTIONS = ['off', 'ask', 'always'] as const;
export const STRADDLE_OPTIONS = ['off', 'utg', 'utg-and-button'] as const;
export const SHOWDOWN_SECONDS = [3, 6, 9] as const;
/** Table felt colours the host can pick. Each player may still see their own. */
export const FELTS = ['green', 'blue', 'red', 'purple', 'charcoal', 'teal'] as const;

export type TableMode = (typeof TABLE_MODES)[number];

/** Ranges the schema enforces, exported so forms show the same limits. All inclusive. */
export const SETTINGS_LIMITS = {
  tableName: { min: 1, max: 40 },
  maxSeats: { min: 2, max: 10 },
  chips: { min: 0, max: MAX_CHIPS },
  gameId: { min: 1, max: 40 },
  rotationSteps: { min: 1, max: 20 },
  rotationLength: { min: 1, max: 1000 },
  blindLevels: { min: 1, max: 100 },
  levelMinutes: { min: 2, max: 240 },
  levelHands: { min: 1, max: 1000 },
  /** 0 turns the clock off; otherwise this range. */
  decisionSeconds: { min: 5, max: 600 },
  timeBankSeconds: { min: 0, max: 300 },
  timeBankRefillHands: { min: 0, max: 200 },
  nextHandDelaySeconds: { min: 0, max: 30 },
  ratholeMinutes: { min: 0, max: 1440 },
  awayAfterTimeouts: { min: 0, max: 10 },
  offlineGraceSeconds: { min: 0, max: 300 },
  releaseOfflineSeatMinutes: { min: 0, max: 1440 },
  fixedLimitCap: { min: 2, max: 10 },
  spectatorDelaySeconds: { min: 0, max: 600 },
} as const;

const L = SETTINGS_LIMITS;

const int = (range: { min: number; max: number }) => z.number().int().min(range.min).max(range.max);

const chips = int(L.chips);

/** Cross-field rules only compare amounts that are valid on their own, so one bad field gives one error. */
const isChips = (v: number) => chips.safeParse(v).success;

/** a > b, for two otherwise valid amounts. */
const exceeds = (a: number, b: number) => isChips(a) && isChips(b) && a > b;

/** v < min, for an otherwise valid amount. */
const below = (v: number, min: number) => isChips(v) && v < min;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const label = (range: { min: number; max: number }) =>
  z
    .string()
    .trim()
    .min(range.min, 'must not be blank')
    .max(range.max, `must be at most ${range.max} characters`)
    .refine((s) => !CONTROL_CHARS.test(s), 'must not contain control characters');

/** Variant id from the variants registry; the server checks that it exists. */
const gameId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, 'must be 1-40 letters, digits, dashes or underscores');

const custom = (ctx: z.RefinementCtx, path: (string | number)[], message: string) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

const TableSection = z
  .object({
    /** Shown in the lobby and the table header. 1-40 characters. */
    name: label(L.tableName),
    /** Seats around the table, 2-10. */
    maxSeats: int(L.maxSeats),
    /** Cash game, or a table run by the tournament director. */
    mode: z.enum(TABLE_MODES),
    /** Felt colour everyone sees unless they pick their own (green when left out). */
    felt: z.enum(FELTS).optional(),
  })
  .strict();

const RotationStepSchema = z
  .object({
    /** Game played during this step. */
    gameId,
    /** Betting structure during this step. */
    betting: z.enum(BETTING_KINDS),
    /** How long the step lasts, in `unit`s (1-1000). */
    length: int(L.rotationLength),
    /** Count hands, or full orbits of the button. */
    unit: z.enum(ROTATION_UNITS),
  })
  .strict();

const GameSection = z
  .object({
    /** Game dealt when no rotation is running (default 'nlhe'). */
    gameId,
    /** Betting structure (default no-limit). */
    betting: z.enum(BETTING_KINDS),
    /** Mixed games: cycle through `steps` in order. */
    rotation: z
      .object({
        /** Rotate games (needs at least one step). */
        enabled: z.boolean(),
        /** Up to 20 steps. */
        steps: z.array(RotationStepSchema).max(L.rotationSteps.max),
      })
      .strict()
      .superRefine((r, ctx) => {
        if (r.enabled && r.steps.length < L.rotationSteps.min) custom(ctx, ['steps'], 'add at least one step to rotate games');
      }),
  })
  .strict();

const StakesSection = z
  .object({
    /** Small blind; 0 allowed for ante-only and stud games. */
    smallBlind: chips,
    /** Big blind; at least 1 for no-limit and pot-limit (it is the minimum bet). */
    bigBlind: chips,
    /** Ante amount; must be 0 when anteType is 'none'. */
    ante: chips,
    /** Who posts the ante: nobody, every player, or the big blind for the table. */
    anteType: z.enum(ANTE_TYPES),
    /** Stud bring-in. */
    bringIn: chips,
    /** Fixed-limit bet on the early streets. */
    smallBet: chips,
    /** Fixed-limit bet on the late streets. */
    bigBet: chips,
    /** Display chips divided by 100 as dollars and cents. Formatting only. */
    centsMode: z.boolean(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (exceeds(s.smallBlind, s.bigBlind)) custom(ctx, ['smallBlind'], `must not exceed the big blind (${s.bigBlind})`);
  });

const BlindLevelSchema = z
  .object({
    /** Small blind for this level. */
    smallBlind: chips,
    /** Big blind for this level. */
    bigBlind: chips,
    /** Ante for this level, posted the way stakes.anteType says. */
    ante: chips,
    /** Level length when countdown is 'per-level-timer' (2-240). */
    minutes: int(L.levelMinutes),
    /** Level length when countdown is 'hands' (1-1000). */
    hands: int(L.levelHands),
  })
  .strict()
  .superRefine((lv, ctx) => {
    if (exceeds(lv.smallBlind, lv.bigBlind)) custom(ctx, ['smallBlind'], `must not exceed the big blind (${lv.bigBlind})`);
  });

const BlindScheduleSection = z
  .object({
    /** Raise the blinds through `levels` (needs at least one level). */
    enabled: z.boolean(),
    /** Move up a level on a clock, or after a number of hands. */
    countdown: z.enum(LEVEL_COUNTDOWNS),
    /** Up to 100 levels, played in order. */
    levels: z.array(BlindLevelSchema).max(L.blindLevels.max),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.enabled && b.levels.length < L.blindLevels.min) custom(ctx, ['levels'], 'add at least one level');
  });

const TimingSection = z
  .object({
    /** Seconds per decision: 0 for no clock, otherwise 5-600. */
    decisionSeconds: z
      .number()
      .int()
      .refine(
        (v) => v === 0 || (v >= L.decisionSeconds.min && v <= L.decisionSeconds.max),
        `must be 0 (no clock) or ${L.decisionSeconds.min}-${L.decisionSeconds.max}`,
      ),
    /** Extra seconds each player can draw on, 0-300. */
    timeBankSeconds: int(L.timeBankSeconds),
    /** Hands between time bank refills, 0-200 (0 = never refills). */
    timeBankRefillHands: int(L.timeBankRefillHands),
    /** Start the time bank automatically when the decision clock runs out. */
    autoActivateTimeBank: z.boolean(),
    /** Deal the next hand without the host pressing start. */
    autoStartNextHand: z.boolean(),
    /** How long a showdown stays on screen: 3, 6 or 9 seconds. */
    showdownSeconds: z.union([z.literal(3), z.literal(6), z.literal(9)], {
      errorMap: (_, ctx) => ({ message: ctx.data === undefined ? 'required' : 'must be 3, 6 or 9' }),
    }),
    /** Pause between hands, 0-30 seconds. */
    nextHandDelaySeconds: int(L.nextHandDelaySeconds),
  })
  .strict();

const SeatingSection = z
  .object({
    /** The host approves every seat request. */
    requireApproval: z.boolean(),
    /** Busted or short players may add chips between hands. */
    allowRebuys: z.boolean(),
    /** Rebuys wait for the host's approval. */
    rebuyRequiresApproval: z.boolean(),
    /** Smallest buy-in; 0 = no minimum (buy-ins are not enforced by default). */
    minBuyIn: chips,
    /** Largest buy-in; 0 = no maximum. */
    maxBuyIn: chips,
    /** Minutes a player who left must come back with at least their old stack; 0 = off. */
    ratholeMinutes: int(L.ratholeMinutes),
    /** Queue players for full tables. */
    waitlist: z.boolean(),
    /** Keep dealing to away players (they auto check or fold). */
    dealToAway: z.boolean(),
    /** Consecutive timeouts before a player is marked away, 0-10 (0 = never). */
    awayAfterTimeouts: int(L.awayAfterTimeouts),
    /** Seconds a disconnected player keeps acting normally before being marked away, 0-300. */
    offlineGraceSeconds: int(L.offlineGraceSeconds),
    /** Minutes offline before the seat is released, 0-1440 (0 = never). */
    releaseOfflineSeatMinutes: int(L.releaseOfflineSeatMinutes),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.minBuyIn > 0 && s.maxBuyIn > 0 && exceeds(s.minBuyIn, s.maxBuyIn)) {
      custom(ctx, ['minBuyIn'], `must not exceed the maximum buy-in (${s.maxBuyIn})`);
    }
  });

const PlaySection = z
  .object({
    /** Run it twice when all in before the river: never, by vote, or every time. Must be 'off' in tournaments. */
    runItTwice: z.enum(RUN_IT_TWICE_OPTIONS),
    /** Players may reveal the cards that would have come after the hand ended. */
    rabbitHunt: z.boolean(),
    /** Optional straddles players may post. */
    straddle: z.enum(STRADDLE_OPTIONS),
    /** Show every live hand at showdown; when false, losing hands may muck. */
    revealAllAtShowdown: z.boolean(),
    /** Cut a bet down to the most any opponent can call, returning the excess at once. */
    trimExcessBets: z.boolean(),
    /** Fixed-limit bets per round, the bet included (2-10). */
    fixedLimitCap: int(L.fixedLimitCap),
    /** No fixed-limit cap when two players are left in the hand. */
    uncappedHeadsUp: z.boolean(),
  })
  .strict();

const ChatSection = z
  .object({
    /** Players without an account may chat. */
    guestChat: z.boolean(),
    /** Mask common profanity in chat. */
    profanityFilter: z.boolean(),
    /** Players may throw gestures at each other (on when left out). */
    gestures: z.boolean().optional(),
  })
  .strict();

const SpectatorsSection = z
  .object({
    /** People who are not seated may watch. */
    allowed: z.boolean(),
    /** Spectators see every hole card (after the delay). */
    seeAllCards: z.boolean(),
    /** Seconds spectators run behind the table, 0-600. */
    delaySeconds: int(L.spectatorDelaySeconds),
  })
  .strict();

/** Registered modifier sections by id; see modifiers.ts. */
const ModifiersSection = z.record(z.string(), z.unknown()).transform(parseModifierSections);

const SettingsObject = z
  .object({
    /** Layout version; migrateSettings upgrades older ones. */
    version: z.literal(SETTINGS_VERSION, {
      errorMap: () => ({ message: `must be ${SETTINGS_VERSION} (use migrateSettings for older settings)` }),
    }),
    table: TableSection,
    game: GameSection,
    stakes: StakesSection,
    blindSchedule: BlindScheduleSection,
    timing: TimingSection,
    seating: SeatingSection,
    play: PlaySection,
    chat: ChatSection,
    spectators: SpectatorsSection,
    modifiers: ModifiersSection,
  })
  .strict();

/** Rules that span sections: mode gates, and stakes the betting structures in play need. */
function checkAcrossSections(s: z.output<typeof SettingsObject>, ctx: z.RefinementCtx): void {
  if (s.table.mode === 'tournament') {
    if (s.play.runItTwice !== 'off') custom(ctx, ['play', 'runItTwice'], "must be 'off' in tournament mode");
    for (const entry of listModifierSchemas()) {
      if (entry.cashOnly && isSectionEnabled(s.modifiers[entry.id])) {
        custom(ctx, ['modifiers', entry.id, 'enabled'], 'cash games only: turn it off in tournament mode');
      }
    }
  }

  const kinds = new Set<BettingKind>([s.game.betting]);
  if (s.game.rotation.enabled) for (const step of s.game.rotation.steps) kinds.add(step.betting);
  const { stakes, blindSchedule } = s;
  const levels = blindSchedule.enabled ? blindSchedule.levels : [];

  if (kinds.has('no-limit') || kinds.has('pot-limit')) {
    const message = 'must be at least 1 for no-limit and pot-limit games';
    if (below(stakes.bigBlind, 1)) custom(ctx, ['stakes', 'bigBlind'], message);
    levels.forEach((lv, i) => {
      if (below(lv.bigBlind, 1)) custom(ctx, ['blindSchedule', 'levels', i, 'bigBlind'], message);
    });
  }
  if (kinds.has('fixed-limit')) {
    if (below(stakes.smallBet, 1)) custom(ctx, ['stakes', 'smallBet'], 'must be at least 1 for fixed-limit games');
    else if (exceeds(stakes.smallBet, stakes.bigBet)) {
      custom(ctx, ['stakes', 'smallBet'], `must not exceed the big bet (${stakes.bigBet})`);
    }
    if (below(stakes.bigBet, 1)) custom(ctx, ['stakes', 'bigBet'], 'must be at least 1 for fixed-limit games');
    if (exceeds(stakes.bringIn, stakes.smallBet)) {
      custom(ctx, ['stakes', 'bringIn'], `must not exceed the small bet (${stakes.smallBet})`);
    }
  }
  if (stakes.anteType === 'none') {
    const message = "must be 0 when stakes.anteType is 'none'";
    if (exceeds(stakes.ante, 0)) custom(ctx, ['stakes', 'ante'], message);
    levels.forEach((lv, i) => {
      if (exceeds(lv.ante, 0)) custom(ctx, ['blindSchedule', 'levels', i, 'ante'], message);
    });
  }
}

/**
 * The whole table settings object, shared by server and web. Every field is
 * required and unknown keys are rejected; use migrateSettings for stored or
 * partial data. Cross-section rules run once each field has the right type.
 * parseSettings wraps this with readable messages; to use the schema directly
 * with the same messages, pass `{ errorMap: settingsErrorMap }`.
 */
export const TableSettingsSchema = SettingsObject.superRefine(checkAcrossSections);

export type TableSettings = z.output<typeof TableSettingsSchema>;
export type BlindLevel = z.output<typeof BlindLevelSchema>;
export type RotationStep = z.output<typeof RotationStepSchema>;
