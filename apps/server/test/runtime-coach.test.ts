import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handDigest, verifyHand } from '@rsdp/engine';
import { engine, variants, type HandState } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { registerAllVariants } from '@rsdp/engine/variants';
import { TableRuntime } from '../src/runtime/table';
import { delayedPart, handRecordView, pastHand, tableView } from '../src/runtime/view';
import { botTuning, coachTuning } from '../src/bots/strategy';
import type { RuntimeState } from '../src/runtime/types';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

// Quick, rough tips and bots: these tests are about who may have one, not how good it is.
const coach = structuredClone(coachTuning);
const bots = { ...botTuning };
beforeAll(() => {
  Object.assign(coachTuning, {
    equity: { thinkMs: 1e9, minSims: 8, maxSims: 8 },
    vsRandom: { thinkMs: 1e9, minSims: 4, maxSims: 4 },
    draw: { screen: 2, final: 4 },
    drawBet: { screen: 2, final: 2 },
    vsRandomUnderMs: 1e9,
  });
  Object.assign(botTuning, { thinkMs: 0, minSims: 4, drawSims: 2, drawFinalSims: 3, drawBetSims: 2, drawBetFinalSims: 2 });
});
afterAll(() => {
  Object.assign(coachTuning, coach);
  Object.assign(botTuning, bots);
});

/** The host, seated, with practice bots beside them; nobody else has sat down yet. */
function practice(patch: (s: TableSettings) => void = () => {}, botCount = 2) {
  const clock = new FakeClock();
  const errors: unknown[] = [];
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  settings.timing.decisionSeconds = 0;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(), log: (m, e) => errors.push([m, e]) });
  for (const p of ['host', 'ann', 'watcher']) rt.connect(p);
  rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200, consent: true });
  for (let i = 0; i < botCount; i++) rt.addBot('host', { ownerName: 'Host' });
  return { rt, clock, errors };
}

const botIds = (rt: TableRuntime) => Object.keys(rt.state.bots ?? {});

/** Moves the clock on, and checks and calls for anyone else at the table, until it is this player's turn. */
function toTurn(rt: TableRuntime, clock: FakeClock, playerId = 'host'): HandState {
  for (let i = 0; i < 4000; i++) {
    const hand = rt.state.hand;
    const seat = hand && hand.phase !== 'complete' && hand.toAct !== null && rt.state.turn ? rt.state.seats[hand.toAct] : null;
    if (seat?.playerId === playerId) return hand!;
    if (seat && !rt.isBot(seat.playerId)) playOn(rt, seat.playerId);
    else clock.advance(200);
  }
  throw new Error(`${playerId} never had a turn`);
}

/** Moves the clock on until a bot is on the clock: they take a moment to play, so there is a window to ask in. */
function toBotTurn(rt: TableRuntime, clock: FakeClock): HandState {
  for (let i = 0; i < 400; i++) {
    const hand = rt.state.hand;
    const seat = hand && hand.phase !== 'complete' && hand.toAct !== null && rt.state.turn ? rt.state.seats[hand.toAct] : null;
    if (seat && rt.isBot(seat.playerId)) return hand!;
    if (seat) playOn(rt, seat.playerId);
    else clock.advance(100);
  }
  throw new Error('no bot was ever on the clock');
}

/** Checks or calls for this player, in a betting round or a draw. */
function playOn(rt: TableRuntime, playerId = 'host') {
  const hand = rt.state.hand!;
  if (hand.phase === 'drawing') return rt.draw(playerId, []);
  const legal = engine.legalActions(hand, hand.toAct!)!;
  rt.act(playerId, legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
}

/** The tip for the decision in front of this player now. */
const tipNow = (rt: TableRuntime, playerId = 'host') => rt.coachTip(playerId, rt.state.hand!.input.handNumber, rt.state.hand!.events.length);

/** Plays until `hands` more hands have been played out, checking and calling for every person at the table. */
function play(rt: TableRuntime, clock: FakeClock, hands: number, onMyTurn: (rt: TableRuntime) => void = () => {}) {
  const want = rt.state.history.length + hands;
  for (let i = 0; i < 20_000 && rt.state.history.length < want; i++) {
    const hand = rt.state.hand;
    const seat = hand && hand.phase !== 'complete' && hand.toAct !== null && rt.state.turn ? rt.state.seats[hand.toAct] : null;
    if (seat && !rt.isBot(seat.playerId)) {
      if (seat.playerId === 'host') onMyTurn(rt);
      playOn(rt, seat.playerId);
      continue;
    }
    clock.advance(500);
  }
  expect(rt.state.history.length).toBeGreaterThanOrEqual(want);
}

describe('who gets a coach tip', () => {
  it('gives one to the one person at a table of bots, on their betting turn and their draw turn', () => {
    const { rt, clock } = practice();
    rt.start('host');
    const hand = toTurn(rt, clock);
    expect(rt.state.coach).toMatchObject({ handNumber: hand.input.handNumber, person: 'host' });
    const tip = tipNow(rt);
    expect(tip).toMatchObject({ handNumber: hand.input.handNumber, at: hand.events.length, kind: 'bet', opponents: 2 });
    expect(tip.share).toBeGreaterThan(0);
    // The same turn asked twice (another tab, or the panel reopened) is the same answer, worked out once.
    expect(tipNow(rt)).toBe(tip);
    // Only they see the flag, and it is not part of what a spectator sees a delay behind.
    expect(tableView(rt, 'host', clock.now()).tips).toBe(true);
    for (const who of ['watcher', '', ...botIds(rt)]) expect(tableView(rt, who, clock.now()).tips, who).toBeFalsy();
    expect('tips' in delayedPart(tableView(rt, 'host', clock.now()))).toBe(false);

    // A draw turn gives the cards to throw.
    const { rt: draw, clock: drawClock } = practice((s) => (s.game.gameId = 'badugi'));
    draw.start('host');
    for (let i = 0; i < 10; i++) {
      const phase = toTurn(draw, drawClock).phase;
      if (phase === 'drawing') break;
      playOn(draw);
    }
    expect(draw.state.hand!.phase).toBe('drawing');
    const drawTip = tipNow(draw);
    expect(drawTip).toMatchObject({ kind: 'draw', call: 0, cost: null, close: false });
    expect(['draw', 'pat']).toContain(drawTip.rule);
    expect(drawTip.move.type).toBe('draw');
  });

  it('refuses everyone else, and every spot that is not their decision now', () => {
    // This table doesn't deal the next hand by itself, so there is a moment with no hand to tip.
    const { rt, clock } = practice((s) => (s.timing.autoStartNextHand = false));
    rt.start('host');
    const hand = toTurn(rt, clock);
    const { handNumber } = hand.input;
    const at = hand.events.length;
    // Nobody but the person in the hand: not a spectator, not staff who aren't seated, not a bot.
    rt.setCoHost('host', 'ann', ['players']);
    for (const who of ['watcher', 'ann', '']) expect(() => rt.coachTip(who, handNumber, at), who).toThrow(/not in this hand/);
    for (const bot of botIds(rt)) expect(() => rt.coachTip(bot, handNumber, at)).toThrow(/everyone else is a bot/);
    // The turn they are asking about has to be the one in front of them.
    expect(() => rt.coachTip('host', handNumber, at + 1)).toThrow(/that turn is over/);
    expect(() => rt.coachTip('host', handNumber + 1, at)).toThrow(/that turn is over/);
    // A bot the table has forgotten counts as a person, so a tip fails closed.
    const forgotten = botIds(rt)[0];
    const kept = rt.state.bots![forgotten];
    delete rt.state.bots![forgotten];
    expect(() => rt.coachTip('host', handNumber, at)).toThrow(/everyone else is a bot/);
    rt.state.bots![forgotten] = kept;
    // Not while the game is paused, and not when it is a bot's turn.
    rt.pause('host', true);
    expect(() => rt.coachTip('host', handNumber, at)).toThrow(/the game is paused/);
    rt.pause('host', false);
    const theirs = toBotTurn(rt, clock);
    expect(() => rt.coachTip('host', theirs.input.handNumber, theirs.events.length)).toThrow(/not your turn/);
    // Nor between hands.
    play(rt, clock, 1);
    expect(() => rt.coachTip('host', rt.state.handNumber, 0)).toThrow(/no hand is being played/);
  });

  it('refuses a hand with a second person in it, however little they play', () => {
    const seatAnn = (rt: TableRuntime) => rt.requestSeat('ann', { seat: 5, name: 'Ann', stack: 200, consent: true });
    // Ann takes her turn.
    const played = practice();
    seatAnn(played.rt);
    played.rt.start('host');
    expect(played.rt.state.coach).toBeNull();
    expect(tableView(played.rt, 'host', played.clock.now()).tips).toBeFalsy();
    const hand = toTurn(played.rt, played.clock);
    expect(hand.seats.some((x) => x.playerId === 'ann')).toBe(true);
    expect(() => played.rt.coachTip('host', hand.input.handNumber, hand.events.length)).toThrow(/everyone else is a bot/);
    expect(() => played.rt.coachTip('ann', hand.input.handNumber, hand.events.length)).toThrow(/everyone else is a bot/);

    // Ann folds the moment she can, and stands up, but it was still her hand too.
    const left = practice();
    seatAnn(left.rt);
    left.rt.start('host');
    toTurn(left.rt, left.clock, 'ann');
    left.rt.act('ann', { type: 'fold' });
    left.rt.stand('ann');
    const after = toTurn(left.rt, left.clock);
    expect(() => left.rt.coachTip('host', after.input.handNumber, after.events.length)).toThrow(/everyone else is a bot/);

    // Dealt in while away (the table deals to away players) is dealt in.
    const away = practice((s) => (s.seating.dealToAway = true));
    seatAnn(away.rt);
    away.rt.disconnect('ann');
    away.clock.advance(5 * 60_000);
    away.rt.start('host');
    const awayHand = toTurn(away.rt, away.clock);
    expect(away.rt.state.hand!.seats.some((x) => x.playerId === 'ann')).toBe(true);
    expect(() => away.rt.coachTip('host', awayHand.input.handNumber, awayHand.events.length)).toThrow(/everyone else is a bot/);
  });

  it('lets this hand finish when someone sits down in the middle of it, and stops at the next deal', () => {
    const { rt, clock } = practice();
    rt.start('host');
    const hand = toTurn(rt, clock);
    rt.requestSeat('ann', { seat: 5, name: 'Ann', stack: 200, consent: true });
    // She was not dealt in, so this hand is still one person against bots.
    expect(rt.coachTip('host', hand.input.handNumber, hand.events.length).kind).toBe('bet');
    play(rt, clock, 1);
    const next = toTurn(rt, clock);
    expect(rt.state.coach).toBeNull();
    expect(() => rt.coachTip('host', next.input.handNumber, next.events.length)).toThrow(/everyone else is a bot/);
  });

  it('never gives one at a table where two people have played a hand, even once they are alone with the bots', () => {
    const { rt, clock } = practice();
    rt.requestSeat('ann', { seat: 5, name: 'Ann', stack: 200, consent: true });
    rt.start('host');
    play(rt, clock, 1);
    expect(rt.state.realGame).toBe(true);
    rt.stand('ann');
    play(rt, clock, 1);
    const hand = toTurn(rt, clock);
    expect(hand.seats.some((x) => x.playerId === 'ann')).toBe(false);
    // Chips won with a tip's help already count when people settle up, so the table keeps tips off for good.
    expect(rt.state.coach).toBeNull();
    expect(tableView(rt, 'host', clock.now()).tips).toBeFalsy();
    expect(() => rt.coachTip('host', hand.input.handNumber, hand.events.length)).toThrow(/everyone else is a bot/);
  });

  it('refuses a tournament table, and a hand restored without the rule settled', () => {
    const settings = defaultSettings('tournament');
    const t = TableRuntime.create({ id: 't2', hostId: 'host', settings }, { clock: new FakeClock(), rng: seeded() });
    // Bots can't be added to a tournament; forging one changes nothing.
    t.state.bots = { 'bot-x': { ownerId: 'host', ownerName: 'Host', buyIn: 100 } };
    expect(() => t.coachTip('host', 1, 0)).toThrow(/no tips in tournaments/);

    const { rt, clock } = practice();
    rt.start('host');
    const hand = toTurn(rt, clock);
    const saved = structuredClone(rt.state) as RuntimeState;
    delete saved.coach;
    const back = new TableRuntime(saved, { clock: new FakeClock(), rng: seeded() });
    back.connect('host');
    back.resume();
    expect(() => back.coachTip('host', hand.input.handNumber, hand.events.length)).toThrow(/everyone else is a bot/);
    expect(tableView(back, 'host', clock.now()).tips).toBeFalsy();
    back.dispose();
    rt.dispose();
  });

  it('is not asked while a vote on running it twice is open', () => {
    const { rt, clock } = practice((s) => {
      s.play.runItTwice = 'ask';
      s.table.maxSeats = 2;
    }, 1);
    rt.start('host');
    // All in on the first betting round against the one bot, which asks the table whether to run it twice.
    for (let i = 0; i < 40 && rt.state.hand!.phase !== 'rit-vote' && rt.state.handNumber < 6; i++) {
      const hand = rt.state.hand!;
      if (hand.phase === 'complete' || hand.toAct === null || rt.state.seats[hand.toAct]?.playerId !== 'host' || !rt.state.turn) {
        clock.advance(300);
        continue;
      }
      const legal = engine.legalActions(hand, hand.toAct)!;
      if (legal.canRaise) rt.act('host', { type: legal.raiseKind === 'bet' ? 'bet' : 'raise', to: legal.maxTo });
      else playOn(rt);
    }
    const hand = rt.state.hand!;
    expect(hand.phase).toBe('rit-vote');
    expect(() => rt.coachTip('host', hand.input.handNumber, hand.events.length)).toThrow(/not your turn/);
    // Bots always say yes, and say so.
    clock.advance(1000);
    expect(rt.state.coach!.notes.some((n) => n.rule === 'rit-yes')).toBe(true);
  });
});

describe('a tip changes nothing about the hand', () => {
  it('deals the same hands, with the same bot moves and the same next commitment, whether tips are asked for or not', () => {
    const run = (ask: boolean) => {
      const { rt, clock, errors } = practice();
      rt.start('host');
      play(rt, clock, 6, (table) => {
        if (ask) tipNow(table);
      });
      const out = {
        commit: rt.nextCommit(),
        // Bots are given a fresh id each time, so seats stand in for them.
        hands: JSON.stringify(
          rt.state.history.map((h) => ({ handNumber: h.handNumber, events: h.hand.events, stacks: h.hand.seats.map((x) => x.stack) })),
          (_key, value) => (typeof value === 'string' && value.startsWith('bot-') ? 'bot' : value),
        ),
      };
      expect(errors).toEqual([]);
      rt.dispose();
      return out;
    };
    const quiet = run(false);
    const asked = run(true);
    expect(asked.hands).toEqual(quiet.hands);
    expect(asked.commit).toBe(quiet.commit);
  });
});

describe('why the bots played that way', () => {
  it('is kept while the hand runs but sent to nobody, then goes to the one person in it once it is over', () => {
    const { rt, clock } = practice((s) => {
      s.spectators.seeAllCards = true;
      s.spectators.delaySeconds = 0;
    });
    rt.start('host');
    toTurn(rt, clock);
    playOn(rt);
    toTurn(rt, clock);
    expect(rt.state.coach!.notes.length).toBeGreaterThan(0);
    // Nothing in any view while the hand is live, not even to a watcher who sees every card.
    for (const who of ['host', 'watcher', '', ...botIds(rt)]) {
      const json = JSON.stringify(tableView(rt, who, clock.now()));
      expect(json, who).not.toContain('botNotes');
      expect(json, who).not.toContain('"rule"');
    }
    play(rt, clock, 1);
    const record = rt.state.history.at(-1)!;
    expect(record.coach!.person).toBe('host');
    const notes = handRecordView(rt, record, 'host', { notes: true }).botNotes!;
    expect(notes.length).toBeGreaterThan(0);
    // Each one explains the move it sits on.
    for (const note of notes) {
      const event = record.hand.events[note.seq];
      expect(['action', 'draw', 'rit-vote'], JSON.stringify(note)).toContain(event.t);
      expect(event).toMatchObject({ seat: note.seat });
      expect(rt.state.seats[note.seat] && rt.isBot(rt.state.seats[note.seat]!.playerId)).toBe(true);
    }
    // Only for them, only when asked for, and never with their own cards hidden (a shared hand).
    expect(handRecordView(rt, record, 'host').botNotes).toBeUndefined();
    expect(handRecordView(rt, record, 'host', { notes: true, hideMine: true }).botNotes).toBeUndefined();
    for (const who of ['watcher', 'ann', '', ...botIds(rt)]) expect(handRecordView(rt, record, who, { notes: true }).botNotes, who).toBeUndefined();
    // And never on a hand that two people played.
    rt.requestSeat('ann', { seat: 5, name: 'Ann', stack: 200, consent: true });
    play(rt, clock, 2);
    const mixed = rt.state.history.at(-1)!;
    expect(mixed.hand.seats.some((x) => x.playerId === 'ann')).toBe(true);
    expect(mixed.coach).toBeUndefined();
    expect(handRecordView(rt, mixed, 'host', { notes: true }).botNotes).toBeUndefined();
    rt.dispose();
  });

  it('survives a card shown late and a table put away and loaded again', () => {
    const { rt, clock } = practice();
    rt.start('host');
    play(rt, clock, 1);
    const record = rt.state.history.at(-1)!;
    const before = handRecordView(rt, record, 'host', { notes: true }).botNotes;
    expect(before!.length).toBeGreaterThan(0);
    // A card shown after the hand replaces the hand on the record, not the reasons.
    const canShow = tableView(rt, 'host', clock.now()).canShow;
    expect(canShow.length).toBeGreaterThan(0);
    rt.show('host', [canShow[0]]);
    expect(handRecordView(rt, rt.state.history.at(-1)!, 'host', { notes: true }).botNotes).toEqual(before);

    // Saved and loaded: the snapshot carries them, the hand history keeps them, and the hands table never sees them.
    const saved = JSON.parse(JSON.stringify(rt.state)) as RuntimeState;
    const back = new TableRuntime(saved, { clock: new FakeClock(), rng: seeded() });
    back.connect('host');
    back.resume();
    expect(handRecordView(back, back.state.history.at(-1)!, 'host', { notes: true }).botNotes).toEqual(before);
    // pastHand is what storage keeps: the reasons ride along in the snapshot only.
    expect(pastHand(record).coach!.notes).toEqual(before);
    back.dispose();
    rt.dispose();
  });

  it('leaves the hand itself, its fingerprint and its check exactly as they were', () => {
    const { rt, clock } = practice((s) => (s.timing.autoStartNextHand = false));
    rt.start('host');
    play(rt, clock, 1);
    const record = rt.state.history.at(-1)!;
    expect(record.coach!.notes.length).toBeGreaterThan(0);
    // The reasons are not events, so nothing new is in the hand.
    const kinds = new Set(record.hand.events.map((e) => e.t));
    for (const kind of kinds) expect(['hand-start', 'post', 'deal', 'board', 'street', 'action', 'draw', 'uncalled', 'rit-offer', 'rit-vote', 'run-it', 'show', 'muck', 'award', 'transfer', 'hand-end']).toContain(kind);
    expect(JSON.stringify(record.hand)).not.toContain('botNotes');
    // The audit digest is of the hand alone: the same with the reasons as without them.
    const digest = (hand: HandState) =>
      handDigest({
        handId: hand.input.handId,
        commit: hand.input.fair!.commit,
        serverSeed: hand.input.fair!.serverSeed,
        button: hand.input.button,
        seats: hand.seats.map((x) => ({ seat: x.seat, playerId: x.playerId, stack: x.startStack })),
        events: hand.events,
      });
    const stripped = structuredClone(record);
    delete stripped.coach;
    expect(digest(stripped.hand)).toBe(digest(record.hand));
    // The hand still checks out once the host stops the game and the seeds are shown.
    rt.stop('host');
    const view = handRecordView(rt, record, 'host', { notes: true });
    expect(view.botNotes!.length).toBeGreaterThan(0);
    const fair = view.fair!;
    const check = verifyHand({
      commit: fair.commit,
      serverSeed: fair.serverSeed!,
      clientSeeds: fair.clientSeeds.map((c) => c.seed),
      handSeed: fair.handSeed,
      button: view.button,
      events: fair.events!,
    });
    expect(check.checks.filter((c) => !c.ok)).toEqual([]);
    expect(check.ok).toBe(true);
    rt.dispose();
  });
});
