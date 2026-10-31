import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engine, variants, type BettingKind, type Card, type HandState } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, registerAllVariants, VARIANT_LIST } from '@rsdp/engine/variants';
import { BOT_THINK_MS, hashKey, HOST_HANDOFF_MS, TableRuntime } from '../src/runtime/table';
import { handRecordView, tableView } from '../src/runtime/view';
import { BOT_LEVELS, BOT_LOOKS } from '@rsdp/engine/wire';
import {
  botTuning,
  chooseMove,
  explainMove,
  handReads,
  normalDecide,
  opponentDraws,
  readPlayers,
  seededRand,
  seenBy,
  situation,
  tipDice,
  type Dice,
  type MoveWhy,
} from '../src/bots/strategy';
import { FakeClock, seeded } from './fake-clock';

beforeAll(() => registerAllVariants(variants));

function table(patch: (s: TableSettings) => void = () => {}) {
  const clock = new FakeClock();
  const errors: unknown[] = [];
  const settings = defaultSettings('cash');
  settings.seating.requireApproval = false;
  patch(settings);
  const rt = TableRuntime.create({ id: 't1', hostId: 'host', settings }, { clock, rng: seeded(), log: (m, e) => errors.push([m, e]) });
  for (const p of ['host', 'a', 'b']) rt.connect(p);
  return { rt, clock, errors };
}

const chips = (rt: TableRuntime) => rt.state.seats.reduce((n, s) => n + (s ? s.stack + s.pendingChips : 0), 0);
const ledgerIn = (rt: TableRuntime) => Object.values(rt.state.ledger).reduce((n, r) => n + r.buyIn - r.cashOut, 0);

/** Moves the clock on, playing the host's turns with a check or call, until `hands` hands have finished. */
function play(rt: TableRuntime, clock: FakeClock, hands: number) {
  const start = rt.state.handNumber;
  for (let i = 0; i < 20_000 && rt.state.handNumber - start < hands; i++) {
    const h = rt.state.hand;
    const seat = h && h.phase !== 'complete' && h.toAct !== null ? rt.state.seats[h.toAct] : null;
    const me = rt.seatOf('host');
    if (me && me.stack === 0 && me.pendingChips === 0) rt.rebuy('host', 300);
    if (seat?.playerId === 'host') {
      if (h!.phase === 'drawing') rt.draw('host', []);
      else {
        const legal = engine.legalActions(h!, h!.toAct!)!;
        rt.act('host', legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
      }
      continue;
    }
    clock.advance(500);
  }
  expect(rt.state.handNumber - start).toBeGreaterThanOrEqual(hands);
}

describe('practice bots', () => {
  // Quick, rough bots: these tests are about the table, not how well they play.
  const tuning = { ...botTuning };
  beforeAll(() => Object.assign(botTuning, { thinkMs: 0, minSims: 4, drawSims: 2, drawFinalSims: 3, drawBetSims: 2, drawBetFinalSims: 2 }));
  afterAll(() => Object.assign(botTuning, tuning));

  it('each get a short name and look of their own, are marked in the view, and sit in the first free seat', () => {
    const { rt } = table();
    rt.requestSeat('host', { seat: 0, name: 'John', stack: 200 });
    const id = rt.addBot('host', { ownerName: 'John' });
    rt.addBot('host', { ownerName: 'John' });
    expect(rt.state.seats[1]).toMatchObject({ playerId: id, name: 'Ace' });
    expect(rt.state.seats[2]?.name).toBe('Chip');
    const view = tableView(rt, 'a', 0);
    expect(view.seats[1]).toMatchObject({ online: true, bot: { ownerId: 'host', ownerName: 'John', look: 0 } });
    expect(view.seats[2]?.bot?.look).toBe(1);
    expect(view.seats[0]?.bot).toBeUndefined();
    expect(rt.state.log.at(-1)?.text).toBe("John's practice bot Chip sat down in seat 3 with 200");
    // Nobody shares a name with a bot: a player called Lucky means the next bot is the one after.
    rt.requestSeat('a', { seat: 5, name: 'lucky', stack: 200 });
    rt.addBot('a', { ownerName: 'Bartholomew-Maximus' });
    expect(rt.state.seats[3]?.name).toBe('Ducky');
    // A bot that leaves keeps its name in the ledger, so the next one is called something else.
    rt.removeBot('host', id);
    rt.addBot('host', { ownerName: 'John' });
    expect(rt.state.seats[1]?.name).toBe('Slick');
    expect(rt.state.ledger[id]).toMatchObject({ name: 'Ace', bot: true, owner: 'John', look: 0 });
  });

  it('give way when a person sits down under a bot\'s name, and get numbers once every name is used', () => {
    const { rt } = table((s) => (s.seating.requireApproval = true));
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    const seated = rt.addBot('host', { ownerName: 'Host' });
    rt.requestSeat('a', { seat: 3, name: 'Ann', stack: 200 });
    rt.approve('host', rt.state.requests.find((r) => r.playerId === 'a')!.id);
    const waiting = rt.addBot('a', { ownerName: 'Ann' });
    expect([rt.seatOf(seated)?.name, rt.state.requests.find((r) => r.playerId === waiting)?.name]).toEqual(['Ace', 'Chip']);
    // Asking for a seat as "ace" renames nobody: anyone could ask, and the host may say no.
    rt.connect('c');
    rt.requestSeat('c', { seat: 7, name: 'Ace', stack: 200 });
    rt.reject('host', rt.state.requests.find((r) => r.playerId === 'c')!.id);
    expect(rt.seatOf(seated)?.name).toBe('Ace');
    // Bo sits down as "ace": the seated bot takes another name, and so does the waiting one when Cy sits as "Chip".
    rt.requestSeat('b', { seat: 6, name: 'ace', stack: 200 });
    expect(rt.seatOf(seated)?.name).toBe('Ace');
    rt.approve('host', rt.state.requests.find((r) => r.playerId === 'b')!.id);
    expect(rt.seatOf(seated)?.name).toBe('Lucky');
    expect(rt.state.log.at(-1)?.text).toBe('Ace is now Lucky');
    rt.requestSeat('c', { seat: 7, name: 'CHIP', stack: 200 });
    rt.approve('host', rt.state.requests.find((r) => r.playerId === 'c')!.id);
    expect(rt.state.requests.find((r) => r.playerId === waiting)?.name).toBe('Ducky');

    // A bot that has left gives way too, so the ledger never shows two players called Ace.
    const { rt: gone } = table();
    gone.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    const left = gone.addBot('host', { ownerName: 'Host' });
    gone.removeBot('host', left);
    gone.requestSeat('a', { seat: 3, name: 'Ace', stack: 200 });
    expect(gone.state.ledger[left]).toMatchObject({ name: 'Chip', bot: true });
    expect(Object.values(gone.state.ledger).map((row) => row.name)).toEqual(['Host', 'Chip', 'Ace']);

    // Someone on the waitlist keeps their name too.
    const { rt: full } = table((s) => {
      s.table.maxSeats = 3;
      s.seating.waitlist = true;
    });
    full.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    full.requestSeat('a', { seat: 1, name: 'Ann', stack: 200 });
    full.requestSeat('b', { seat: 2, name: 'Bo', stack: 200 });
    full.connect('c');
    full.joinWaitlist('c', { name: 'Ace', stack: 200 });
    // Bo's seat is held for Ace on the waitlist; Ann's is free for a bot.
    full.stand('b');
    full.stand('a');
    expect(full.seatOf(full.addBot('host', { ownerName: 'Host' }))?.name).toBe('Chip');

    const { rt: busy } = table((s) => (s.table.maxSeats = 2));
    busy.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    for (const look of BOT_LOOKS) {
      const id = busy.addBot('host', { ownerName: 'Host' });
      expect(busy.seatOf(id)?.name).toBe(look.name);
      busy.removeBot('host', id);
    }
    const again = busy.addBot('host', { ownerName: 'Host' });
    expect(busy.seatOf(again)?.name).toBe('Ace 2');
    expect(busy.botInfo(again)?.look).toBe(0);
    // Numbered names still get a robot no bot here has: with Ace still seated, the next one is Chip 2, not Ace 2.
    const { rt: long } = table((s) => (s.table.maxSeats = 3));
    long.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    const ace = long.addBot('host', { ownerName: 'Host' });
    for (let i = 1; i < BOT_LOOKS.length; i++) long.removeBot('host', long.addBot('host', { ownerName: 'Host' }));
    const next = long.addBot('host', { ownerName: 'Host' });
    expect([long.seatOf(ace)?.name, long.seatOf(next)?.name, long.botInfo(next)?.look]).toEqual(['Ace', 'Chip 2', 1]);
  });

  it('keep their robot in the hands they played, after they leave', () => {
    const { rt, clock } = table((s) => (s.timing.decisionSeconds = 0));
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.addBot('host', { ownerName: 'Host' });
    const bot = rt.addBot('host', { ownerName: 'Host' });
    rt.start('host');
    play(rt, clock, 1);
    rt.removeBot('host', bot);
    play(rt, clock, 1);
    expect(rt.seatOf(bot)).toBeNull();
    const record = handRecordView(rt, rt.state.history[0], 'host');
    expect(record.seats.find((x) => x.playerId === bot)).toMatchObject({ name: 'Chip', bot: { ownerName: 'Host', look: 1 } });
    expect(record.seats.find((x) => x.playerId === 'host')?.bot).toBeUndefined();
  });

  it('fill a whole table with no two bots alike', () => {
    const { rt } = table((s) => (s.table.maxSeats = 10));
    for (let i = 0; i < 10; i++) rt.addBot('host', { ownerName: 'Host' });
    const bots = rt.state.seats.map((x) => rt.botInfo(x!.playerId)!);
    expect(new Set(bots.map((b) => b.look)).size).toBe(10);
    expect(new Set(rt.state.seats.map((x) => x!.name)).size).toBe(10);
    expect(rt.state.seats.every((x) => BOT_LOOKS[rt.botInfo(x!.playerId)!.look!].name === x!.name)).toBe(true);
  });

  it('saved before bots had looks get a name and picture of their own when the table comes back', () => {
    // Ann is offline here and runs out of time on her turns, so the hand moves on without her.
    const { rt } = table((s) => (s.seating.requireApproval = true));
    rt.requestSeat('host', { seat: 0, name: 'Beth', stack: 200 });
    rt.requestSeat('a', { seat: 5, name: 'Ann', stack: 200 });
    rt.approve('host', rt.state.requests[0].id);
    const one = rt.addBot('host', { ownerName: 'Beth' });
    const two = rt.addBot('host', { ownerName: 'Beth' });
    rt.start('host');
    const three = rt.addBot('a', { ownerName: 'Ann' });
    // What an older server saved mid-hand: no looks, and every bot named after its owner.
    const saved = structuredClone(rt.state);
    for (const [id, name] of [[one, "Beth's Poker Bot"], [two, "Beth's Poker Bot 2"], [three, "Ann's Poker Bot"]]) {
      delete saved.bots![id].look;
      const seat = saved.seats.find((x) => x?.playerId === id);
      if (seat) seat.name = name;
      const request = saved.requests.find((r) => r.playerId === id);
      if (request) request.name = name;
      if (saved.ledger[id]) saved.ledger[id] = { playerId: id, name, buyIn: saved.ledger[id].buyIn, cashOut: 0, bot: true };
    }
    const clock = new FakeClock();
    const back = new TableRuntime(saved, { clock, rng: seeded() });
    back.connect('host');
    back.resume();
    expect([back.seatOf(one)?.name, back.seatOf(two)?.name]).toEqual(['Ace', 'Chip']);
    expect(back.state.ledger[two]).toMatchObject({ name: 'Chip', owner: 'Beth', look: 1 });
    expect(tableView(back, 'host', 0).seats[2]?.bot).toEqual({ ownerId: 'host', ownerName: 'Beth', look: 1, level: 'normal' });
    expect(back.state.log.slice(-3).map((l) => l.text)).toEqual(["Beth's Poker Bot is now Ace", "Beth's Poker Bot 2 is now Chip", "Ann's Poker Bot is now Lucky"]);
    // The waiting bot sits under its new name, and the hand in progress plays on.
    back.approve('host', back.state.requests.find((r) => r.playerId === three)!.id);
    expect(back.seatOf(three)?.name).toBe('Lucky');
    play(back, clock, 2);
    back.dispose();
  });

  it('players must be seated, the host can turn them off for players, and players have a limit', () => {
    const { rt } = table();
    expect(() => rt.addBot('a', { ownerName: 'Ann' })).toThrow(/take a seat/);
    rt.requestSeat('a', { seat: 0, name: 'Ann', stack: 200 });
    for (let i = 0; i < 3; i++) rt.addBot('a', { ownerName: 'Ann' });
    expect(() => rt.addBot('a', { ownerName: 'Ann' })).toThrow(/at most 3/);
    rt.updateSettings('host', { seating: { allowPlayerBots: false } });
    rt.requestSeat('b', { seat: 6, name: 'Bo', stack: 200 });
    expect(() => rt.addBot('b', { ownerName: 'Bo' })).toThrow(/turned off/);
    // The host always can.
    expect(() => rt.addBot('host', { ownerName: 'Host' })).not.toThrow();
  });

  it('wait for approval when the table approves seats, and stay out of tournaments', () => {
    const { rt } = table((s) => (s.seating.requireApproval = true));
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 200 });
    rt.approve('host', rt.state.requests.find((r) => r.playerId === 'a')!.id);
    const bot = rt.addBot('a', { ownerName: 'Ann', seat: 4 });
    expect(rt.state.seats[4]).toBeNull();
    const req = rt.state.requests.find((r) => r.playerId === bot)!;
    expect(req.name).toBe('Ace');
    expect(rt.state.log.at(-1)?.text).toBe('Ann asked to add a practice bot, Ace, in seat 5');
    expect(tableView(rt, 'host', 0).requests).toMatchObject([{ playerId: bot, name: 'Ace', bot: { ownerId: 'a', ownerName: 'Ann' } }]);
    rt.approve('host', req.id);
    expect(rt.state.seats[4]?.playerId).toBe(bot);

    const settings = defaultSettings('tournament');
    const t = TableRuntime.create({ id: 't2', hostId: 'host', settings }, { clock: new FakeClock(), rng: seeded() });
    expect(() => t.addBot('host')).toThrow(/tournaments/);
  });

  it('play at the level they were added at (Normal if none), which their owner or the host can change', () => {
    const { rt } = table();
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 200 });
    rt.requestSeat('b', { seat: 2, name: 'Bo', stack: 200 });
    const plain = rt.addBot('a', { ownerName: 'Ann' });
    const hard = rt.addBot('a', { ownerName: 'Ann', level: 'hard' });
    expect(rt.state.bots![plain].level).toBe('normal');
    expect(tableView(rt, 'b', 0).seats.find((s) => s?.playerId === hard)?.bot).toMatchObject({ ownerName: 'Ann', level: 'hard' });
    expect(() => rt.addBot('a', { level: 'expert' as never })).toThrow(/no such level/);
    expect(() => rt.setBotLevel('b', hard, 'easy')).toThrow(/owner or the host/);
    expect(() => rt.setBotLevel('a', hard, 'expert' as never)).toThrow(/no such level/);
    rt.setBotLevel('a', hard, 'easy');
    expect(rt.state.bots![hard].level).toBe('easy');
    expect(rt.state.log.at(-1)?.text).toBe('Ann set Chip to Easy');
    rt.setBotLevel('host', plain, 'hard');
    expect(rt.state.bots![plain].level).toBe('hard');
    // A co-host with player powers manages players' bots, but not the host's.
    const hostBot = rt.addBot('host', { ownerName: 'Host' });
    rt.setCoHost('host', 'b', ['players']);
    rt.setBotLevel('b', hard, 'normal');
    expect(rt.state.bots![hard].level).toBe('normal');
    expect(() => rt.setBotLevel('b', hostBot, 'easy')).toThrow(/only the host/);
    // Bots saved before levels play as Normal.
    delete rt.state.bots![plain].level;
    expect(tableView(rt, 'a', 0).seats.find((s) => s?.playerId === plain)?.bot?.level).toBe('normal');
  });

  it('the owner or the host removes a bot; nobody else can, and a bot is never the host', () => {
    const { rt, clock } = table();
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 200 });
    rt.requestSeat('b', { seat: 2, name: 'Bo', stack: 200 });
    const annBot = rt.addBot('a', { ownerName: 'Ann' });
    const hostBot = rt.addBot('host', { ownerName: 'Host' });
    expect(() => rt.removeBot('b', annBot)).toThrow(/owner or the host/);
    expect(() => rt.transferHost('host', annBot)).toThrow(/bot/);
    rt.removeBot('a', annBot);
    expect(rt.seatOf(annBot)).toBeNull();
    expect(rt.isBot(annBot)).toBe(false);
    expect(rt.state.ledger[annBot]).toMatchObject({ name: 'Ace', cashOut: 200 });
    // Mid-hand, the bot folds and goes when the hand ends.
    rt.start('host');
    rt.removeBot('host', hostBot);
    expect(rt.state.hand!.seats.find((x) => x.playerId === hostBot)?.folded).toBe(true);
    // An offline host hands the table to a person, never to a bot.
    rt.disconnect('host');
    rt.disconnect('a');
    rt.addBot('b', { ownerName: 'Bo' });
    clock.advance(HOST_HANDOFF_MS + 1000);
    expect(rt.state.hostId).toBe('b');
  });

  it('play by themselves after a short pause, rebuy when busted, and stop when no person is left', () => {
    const { rt, clock, errors } = table((s) => (s.timing.decisionSeconds = 0));
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.addBot('host', { ownerName: 'Host', stack: 20 });
    rt.addBot('host', { ownerName: 'Host', stack: 20 });
    rt.start('host');
    play(rt, clock, 40);
    expect(errors).toEqual([]);
    expect(chips(rt)).toBe(ledgerIn(rt));
    expect(rt.state.log.some((l) => /bought back in for 20/.test(l.text))).toBe(true);
    // Without a clock a person can take all night; a bot moves within a couple of seconds.
    if (rt.state.hand?.phase !== 'complete' && rt.state.seats[rt.state.hand!.toAct!]?.playerId !== 'host') {
      const before = rt.state.hand!.events.length;
      clock.advance(BOT_THINK_MS - 10);
      expect(rt.state.hand!.events.length).toBe(before);
    }
    rt.stand('host');
    clock.advance(60_000);
    const n = rt.state.handNumber;
    clock.advance(10 * 60_000);
    expect(rt.state.handNumber).toBe(n);
  });

  for (const spec of VARIANT_LIST) {
    for (const betting of ['no-limit', 'pot-limit', 'fixed-limit'] as BettingKind[]) {
      if (spec.defaultBetting !== betting && betting !== 'fixed-limit' && spec.family !== 'flop') continue;
      it(`play ${spec.name} (${betting}) legally`, () => {
        const stud = spec.family === 'stud';
        const { rt, clock, errors } = table((s) => {
          s.game.gameId = spec.id;
          s.game.betting = betting;
          s.table.maxSeats = Math.min(spec.maxPlayers, 6);
          if (stud) Object.assign(s.stakes, { smallBlind: 0, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 0 });
          s.timing.decisionSeconds = 0;
        });
        rt.requestSeat('host', { seat: 0, name: 'Host', stack: 300 });
        // Every level plays every game.
        for (let i = 0; i < Math.min(spec.maxPlayers, 6) - 1; i++) rt.addBot('host', { ownerName: 'Host', level: BOT_LEVELS[i % BOT_LEVELS.length] });
        rt.start('host');
        play(rt, clock, 12);
        expect(errors).toEqual([]);
        expect(chips(rt)).toBe(ledgerIn(rt));
      });
    }
  }
});

/** Deals one hand with a stacked deck and returns it, with seat 0 to act. */
function dealt(gameId: string, cards: string[], players = 2) {
  const spec = getVariant(gameId);
  const rest = 'AKQJT98765432'.split('').flatMap((r) => 'cdhs'.split('').map((s) => r + s)).filter((c) => !cards.includes(c));
  return engine.startHand({
    handId: 'h',
    handNumber: 1,
    game: spec,
    betting: spec.defaultBetting,
    stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 1, smallBet: 2, bigBet: 4 },
    maxSeats: players,
    seats: Array.from({ length: players }, (_, i) => ({ seat: i, playerId: `p${i}`, stack: 200, away: false })),
    button: 1,
    buttonDead: false,
    posts: [
      { seat: 0, kind: 'small-blind', amount: 1, live: true },
      { seat: 1, kind: 'big-blind', amount: 2, live: true },
    ],
    deck: [...cards, ...rest],
    reshuffleSeed: 1,
    options: { boards: 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: false },
    modifiers: [],
  });
}

describe('bot strategy', () => {
  it('raises aces and folds the worst hand to a raise', () => {
    // Seat 0 posts the small blind and acts first.
    const aces = dealt('nlhe', ['As', '2c', 'Ah', '7d']);
    expect(aces.toAct).toBe(0);
    const move = chooseMove(aces, 0, seededRand(1));
    expect(move.kind === 'act' && ['raise', 'bet'].includes(move.action.type)).toBe(true);

    const junk = dealt('nlhe', ['7c', 'As', '2d', 'Ah'], 2);
    engine.act(junk, 0, { type: 'call' });
    engine.act(junk, 1, { type: 'raise', to: 40 });
    const fold = chooseMove(junk, 0, seededRand(1));
    expect(fold).toEqual({ kind: 'act', action: { type: 'fold' } });
  });

  it('Hard reads a big raise from a player who rarely raises as a strong hand; Normal plays it as a random one', () => {
    // King-nine is ahead of a random hand, but not of the hands people raise ten times the big blind with.
    const raised = () => {
      const hand = dealt('nlhe', ['Kc', 'Qs', '9d', 'Jh'], 2);
      engine.act(hand, 0, { type: 'call' });
      engine.act(hand, 1, { type: 'raise', to: 20 });
      return hand;
    };
    const tuning = { ...botTuning };
    Object.assign(botTuning, { thinkMs: 1e9, minSims: 0, maxSims: 500 });
    try {
      let normalCalls = 0;
      let hardCalls = 0;
      for (let i = 0; i < 8; i++) {
        const normal = chooseMove(raised(), 0, seededRand(i));
        const hard = chooseMove(raised(), 0, seededRand(i), { level: 'hard' });
        if (normal.kind === 'act' && normal.action.type !== 'fold') normalCalls++;
        if (hard.kind === 'act' && hard.action.type !== 'fold') hardCalls++;
      }
      expect(normalCalls).toBe(8);
      expect(hardCalls).toBe(0);
      // Against a player who raises nearly every time, a raise says little: Hard calls too.
      const maniac = { p1: { acts: 40, aggressive: 36, faced: 10, folds: 0 } };
      const vsManiac = chooseMove(raised(), 0, seededRand(1), { level: 'hard', players: maniac });
      expect(vsManiac.kind === 'act' && vsManiac.action.type).not.toBe('fold');
    } finally {
      Object.assign(botTuning, tuning);
    }
  });

  it('Hard follows how many cards an opponent draws in 2-7 Triple Draw', () => {
    // I (seat 1) stand pat with a jack-low three times; they stand pat each time, draw three each time, or let the
    // clock stand pat for them, then bet the end.
    const toTheEnd = (theirDraw: number[] | 'timed out') => {
      const hand = dealt('td27', ['Kc', 'Js', 'Qd', '8d', 'Th', '6c', '9s', '4h', 'Kh', '2s']);
      for (let i = 0; i < 40 && hand.phase !== 'complete'; i++) {
        const seat = hand.toAct!;
        if (hand.phase === 'drawing' && seat === 0 && theirDraw === 'timed out') engine.timeout(hand, 0);
        else if (hand.phase === 'drawing') engine.draw(hand, seat, seat === 0 ? (theirDraw as number[]) : []);
        else if (seat === 1) break;
        else if (hand.street === hand.input.game.streets.length - 1) engine.act(hand, 0, { type: 'bet', to: 4 });
        else engine.act(hand, 0, engine.legalActions(hand, 0)!.canCheck ? { type: 'check' } : { type: 'call' });
        if (hand.street === hand.input.game.streets.length - 1 && hand.toAct === 1 && hand.currentBet > 0) break;
        if (hand.toAct === 1 && hand.phase === 'betting') engine.act(hand, 1, { type: 'check' });
      }
      expect(hand.toAct).toBe(1);
      expect(hand.currentBet).toBe(4);
      return hand;
    };
    const tuning = { ...botTuning };
    Object.assign(botTuning, { thinkMs: 1e9, minSims: 0, maxSims: 300 });
    try {
      const calls = (theirDraw: number[] | 'timed out', level: 'normal' | 'hard') =>
        Array.from({ length: 8 }, (_, i) => chooseMove(toTheEnd(theirDraw), 1, seededRand(i), { level })).filter((m) => m.kind === 'act' && m.action.type !== 'fold').length;
      // Normal can't tell the two apart; Hard calls the drawer down and gives the pat hand credit.
      expect(calls([], 'normal')).toBe(calls([0, 1, 2], 'normal'));
      expect(calls([0, 1, 2], 'hard')).toBe(8);
      expect(calls([], 'hard')).toBe(0);
      // A stand-pat the clock made says nothing about their cards.
      expect(calls('timed out', 'hard')).toBe(8);
    } finally {
      Object.assign(botTuning, tuning);
    }
  });

  it('Hard reads a draw-game opponent the same wherever they sit', () => {
    // Four players, button in seat 0. One player raises, stands pat and bets; the other two call and draw three.
    // I (seat 0) throw two cards and must call or fold. The deck is the same, so my cards are too.
    const spot = (pat: number, seed: number) => {
      const spec = getVariant('badugi');
      const r = seededRand(seed);
      const deck = 'AKQJT98765432'.split('').flatMap((x) => 'cdhs'.split('').map((s) => x + s));
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const hand = engine.startHand({
        handId: 'h',
        handNumber: 1,
        game: spec,
        betting: spec.defaultBetting,
        stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 1, smallBet: 2, bigBet: 4 },
        maxSeats: 4,
        seats: Array.from({ length: 4 }, (_, i) => ({ seat: i, playerId: `p${i}`, stack: 200, away: false })),
        button: 0,
        buttonDead: false,
        posts: [
          { seat: 1, kind: 'small-blind', amount: 1, live: true },
          { seat: 2, kind: 'big-blind', amount: 2, live: true },
        ],
        deck,
        reshuffleSeed: 1,
        options: { boards: 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: false },
        modifiers: [],
      });
      for (let i = 0; i < 100; i++) {
        const seat = hand.toAct!;
        if (hand.phase === 'drawing') engine.draw(hand, seat, seat === pat ? [] : seat === 0 ? [0, 1] : [0, 1, 2]);
        else if (seat === 0 && hand.street === 1) return hand;
        else {
          const legal = engine.legalActions(hand, seat)!;
          if (seat === pat && legal.canRaise && hand.raisesThisRound < 1) engine.act(hand, seat, { type: legal.raiseKind === 'bet' ? 'bet' : 'raise', to: legal.minTo });
          else engine.act(hand, seat, legal.canCheck ? { type: 'check' } : { type: 'call' });
        }
      }
      throw new Error('never got to my turn');
    };
    const tuning = { ...botTuning };
    Object.assign(botTuning, { thinkMs: 1e9, minSims: 0, maxSims: 300 });
    try {
      const moves = (pat: number) =>
        Array.from({ length: 16 }, (_, i) => {
          const hand = spot(pat, i + 1);
          expect(hand.currentBet).toBe(2);
          const move = chooseMove(hand, 0, seededRand(i + 1), { level: 'hard' });
          return move.kind === 'act' ? move.action.type : 'draw';
        });
      const first = moves(1);
      // It gives the pat hand credit (and calls the drawers down) whether the pat hand sits before or after them.
      expect(moves(3)).toEqual(first);
      expect(first.filter((m) => m === 'fold').length).toBeGreaterThanOrEqual(10);
    } finally {
      Object.assign(botTuning, tuning);
    }
  });

  it('Hard keeps the bigger badugi round a blocked low card, and breaks up a straight or flush draw in 2-7', () => {
    // My cards (seat 0, first to draw) and theirs, dealt one each in turn.
    const throws = (game: string, mine: string[], theirs: string[]) =>
      Array.from({ length: 4 }, (_, i) => {
        const hand = dealt(game, mine.flatMap((c, j) => [c, theirs[j]]));
        engine.act(hand, 0, { type: 'call' });
        engine.act(hand, 1, { type: 'check' });
        const move = chooseMove(hand, 0, seededRand(i + 1), { level: 'hard' });
        return move.kind === 'draw' ? move.discard.map((d) => mine[d]).join(' ') : move.kind;
      });
    const all = (cards: string) => Array(4).fill(cards);
    // The 2c blocks both the 3c and the 2d: throw it for a three-card badugi, not stand pat with two.
    expect(throws('badugi', ['2c', '3c', '4h', '2d'], ['Kc', 'Qd', 'Js', 'Th'])).toEqual(all('2c'));
    expect(throws('badugi', ['As', 'Ah', '2s', '3d'], ['Kc', 'Qd', 'Js', 'Th'])).toEqual(all('As'));
    // 3-4-5-6 would make a straight with a 2 or a 7; 3-4-5-7 only with a 6.
    expect(throws('td27', ['3d', '4c', '5h', '6s', '7d'], ['Kc', 'Qd', 'Js', 'Th', '9c'])).toEqual(all('6s'));
    // Keep the 4 of spades, not four diamonds.
    expect(throws('td27', ['3d', '4d', '7d', '6d', '4s'], ['Kc', 'Qd', 'Js', 'Th', '9c'])).toEqual(all('4d'));
  });

  it('learns how players play from the hands the table keeps', () => {
    const hand = dealt('nlhe', ['7c', 'As', '2d', 'Ah'], 2);
    engine.act(hand, 0, { type: 'call' });
    engine.act(hand, 1, { type: 'raise', to: 8 });
    engine.act(hand, 0, { type: 'fold' });
    expect(readPlayers([hand])).toEqual({
      // Folding to the raise was facing a bet; calling the big blind alone wasn't.
      p0: { acts: 2, aggressive: 0, faced: 1, folds: 1 },
      p1: { acts: 1, aggressive: 1, faced: 0, folds: 0 },
    });
  });

  it('draws sensibly in 2-7 Triple Draw and Badugi', () => {
    // 2-7: keep 7-3-2, throw the kings.
    const td = dealt('td27', ['2c', 'Ah', '3d', 'Ad', '7s', 'As', 'Kc', 'Qh', 'Kd', 'Qd']);
    engine.act(td, 0, { type: 'call' });
    engine.act(td, 1, { type: 'check' });
    expect(td.phase).toBe('drawing');
    const seat = td.toAct!;
    const move = chooseMove(td, seat, seededRand(3));
    const cards = td.seats.find((x) => x.seat === seat)!.cards.map((c) => c.card);
    expect(move.kind).toBe('draw');
    const thrown = (move as { discard: number[] }).discard.map((i) => cards[i]).sort();
    expect(seat).toBe(0);
    expect(thrown).toEqual(['Kc', 'Kd']);

    // Badugi: a four-suit hand with low cards stands pat.
    const bd = dealt('badugi', ['Ac', 'Kh', '2d', 'Kd', '3h', 'Ks', '4s', 'Qh']);
    engine.act(bd, 0, { type: 'call' });
    engine.act(bd, 1, { type: 'check' });
    const pat = chooseMove(bd, bd.toAct!, seededRand(3));
    expect(bd.toAct).toBe(0);
    expect(pat).toEqual({ kind: 'draw', discard: [] });
  });
});

describe('bots and the money', () => {
  it('stay out of the ledger players see, and the host cannot sit one out', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    const rt = TableRuntime.create({ id: 't3', hostId: 'host', settings }, { clock, rng: seeded() });
    rt.connect('host');
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    const bot = rt.addBot('host', { ownerName: 'Host' });
    expect(rt.state.ledger[bot]?.bot).toBe(true);
    expect(tableView(rt, 'host', 0).ledger.map((r) => [r.playerId, !!r.bot])).toEqual([
      ['host', false],
      [bot, true],
    ]);
    expect(() => rt.hostSitOut('host', bot)).toThrow(/remove the bot/);
    // A bot set to nothing buys back in at the next deal instead of sitting out for good.
    rt.addBot('host', { ownerName: 'Host' });
    rt.setStack('host', bot, 0);
    rt.start('host');
    expect(rt.seatOf(bot)).toMatchObject({ stack: expect.any(Number), sittingOut: false });
    expect(rt.state.hand?.seats.some((x) => x.playerId === bot)).toBe(true);
  });

  it('a table of people only still deals to everyone away when it deals to away players', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    settings.seating.requireApproval = false;
    settings.seating.dealToAway = true;
    const rt = TableRuntime.create({ id: 't4', hostId: 'host', settings }, { clock, rng: seeded() });
    rt.connect('host');
    rt.connect('a');
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 200 });
    rt.disconnect('host');
    rt.disconnect('a');
    clock.advance(60_000);
    rt.start('host');
    expect(rt.state.handNumber).toBe(1);
  });
});

describe('bots keep playing', () => {
  it('a bot marked busted outside a hand (a late 7-2 claim, the Nit game) buys back in at the next deal', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    const rt = TableRuntime.create({ id: 't5', hostId: 'host', settings }, { clock, rng: seeded() });
    rt.connect('host');
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    const a = rt.addBot('host', { ownerName: 'Host' });
    rt.addBot('host', { ownerName: 'Host' });
    const seat = rt.seatOf(a)!;
    seat.stack = 0;
    seat.sittingOut = true;
    seat.sitOutReason = 'busted';
    rt.start('host');
    expect(rt.seatOf(a)).toMatchObject({ stack: 200, sittingOut: false, sitOutReason: null });
    expect(rt.state.hand?.seats.some((x) => x.playerId === a)).toBe(true);
  });

  it('a player sees their own bot waiting for approval and can take it back', () => {
    const clock = new FakeClock();
    const settings = defaultSettings('cash');
    const rt = TableRuntime.create({ id: 't6', hostId: 'host', settings }, { clock, rng: seeded() });
    rt.connect('host');
    rt.connect('a');
    rt.requestSeat('host', { seat: 0, name: 'Host', stack: 200 });
    rt.requestSeat('a', { seat: 1, name: 'Ann', stack: 200 });
    rt.approve('host', rt.state.requests[0].id);
    const bot = rt.addBot('a', { ownerName: 'Ann' });
    expect(tableView(rt, 'a', 0).requests).toMatchObject([{ playerId: bot, bot: { ownerId: 'a', ownerName: 'Ann' }, name: 'Ace' }]);
    expect(tableView(rt, 'b', 0).requests).toEqual([]);
    rt.removeBot('a', bot);
    expect(rt.state.requests).toEqual([]);
    expect(rt.isBot(bot)).toBe(false);
  });

  it('two strong bots heads-up in uncapped fixed limit stop re-raising', () => {
    const spec = getVariant('nlhe');
    const rest = 'AKQJT98765432'.split('').flatMap((r) => 'cdhs'.split('').map((x) => r + x));
    const top = ['As', 'Ac', 'Ad', 'Kc', 'Ah', 'Kd', 'Qc', '7s', '2h'];
    const hand = engine.startHand({
      handId: 'h',
      handNumber: 1,
      game: spec,
      betting: 'fixed-limit',
      stakes: { smallBlind: 1, bigBlind: 2, ante: 0, anteType: 'none', bringIn: 0, smallBet: 2, bigBet: 4 },
      maxSeats: 2,
      seats: [0, 1].map((i) => ({ seat: i, playerId: `p${i}`, stack: 400, away: false })),
      button: 1,
      buttonDead: false,
      posts: [
        { seat: 0, kind: 'small-blind', amount: 1, live: true },
        { seat: 1, kind: 'big-blind', amount: 2, live: true },
      ],
      deck: [...top, ...rest.filter((c) => !top.includes(c))],
      reshuffleSeed: 1,
      options: { boards: 1, bombPot: false, runItTwice: 'off', fixedLimitCap: 4, uncappedHeadsUp: true },
      modifiers: [],
    });
    let raises = 0;
    for (let i = 0; i < 200 && hand.phase === 'betting' && hand.toAct !== null; i++) {
      const move = chooseMove(hand, hand.toAct, seededRand(i));
      if (move.kind !== 'act') throw new Error('no draws in hold’em');
      if (move.action.type === 'raise' || move.action.type === 'bet') raises++;
      engine.act(hand, hand.toAct, move.action);
    }
    expect(hand.phase).toBe('complete');
    // At most seven raises a round on four rounds, and both keep chips behind.
    expect(raises).toBeLessThanOrEqual(28);
    expect(hand.seats.every((x) => !x.allIn)).toBe(true);
  });
});

describe('bots explain their moves', () => {
  it('give the move chooseMove makes, with the numbers behind it', () => {
    const aces = dealt('nlhe', ['As', '2c', 'Ah', '7d']);
    const { move, why } = explainMove(aces, 0, seededRand(1));
    expect(move).toEqual(chooseMove(aces, 0, seededRand(1)));
    expect(why).toMatchObject({ rule: 'raise', opponents: 1, drawsLeft: 0, split: false, big: false, capped: false });
    expect(why.equity).toBeGreaterThan(0.8);
    // Facing a raise to 40 with seven-deuce: the call costs 38 of the 80 the pot would hold.
    const junk = dealt('nlhe', ['7c', 'As', '2d', 'Ah']);
    engine.act(junk, 0, { type: 'call' });
    engine.act(junk, 1, { type: 'raise', to: 40 });
    const fold = explainMove(junk, 0, seededRand(1)).why;
    expect(fold).toMatchObject({ rule: 'fold', cost: 38 / 80, big: false });
    expect(fold.need).toBeCloseTo(38 / 80 + 0.03);
    expect(fold.equity).toBeLessThan(fold.need!);
    // Omaha 8 or better splits the pot.
    expect(explainMove(dealt('plo8', ['As', 'Kc', '2h', 'Kd', '3c', 'Qs', '4d', 'Qh']), 0, seededRand(1)).why.split).toBe(true);
  });

  it('say how many cards they threw, and what the next best draw came to', () => {
    const td = dealt('td27', ['2c', 'Ah', '3d', 'Ad', '7s', 'As', 'Kc', 'Qh', 'Kd', 'Qd']);
    engine.act(td, 0, { type: 'call' });
    engine.act(td, 1, { type: 'check' });
    const { move, why } = explainMove(td, 0, seededRand(3));
    expect(move).toEqual(chooseMove(td, 0, seededRand(3)));
    expect(why).toMatchObject({ rule: 'draw', thrown: 2, drawsLeft: 3 });
    expect(why.alt!.equity).toBeLessThanOrEqual(why.equity!);
    expect(why.alt!.thrown).not.toBe(2);
  });

  it('Hard says how it sat and whose folds it counted on', () => {
    const hand = dealt('nlhe', ['Kc', 'Qs', '9d', 'Jh']);
    engine.act(hand, 0, { type: 'call' });
    engine.act(hand, 1, { type: 'raise', to: 20 });
    const players = { p1: { acts: 30, aggressive: 3, faced: 14, folds: 10 } };
    const { why } = explainMove(hand, 0, seededRand(1), { level: 'hard', players });
    expect(why).toMatchObject({ foldFrom: 'p1', foldRate: (10 + 2.1) / (14 + 6), lastRound: false });
    expect(typeof why.inPosition).toBe('boolean');
  });

  it("tip dice never bluff, steal or semi-bluff; they take the raise band and the smallest size", () => {
    for (const label of ['bluff', 'steal', 'semi-bluff'] as const) expect(tipDice.roll(label, 1)).toBe(false);
    expect(tipDice.roll('raise-band', 0)).toBe(true);
    expect(tipDice.between('size', 0.5, 0.25)).toBe(0.5);
    // Dice that hit every time make Normal bluff on the turn heads-up; tip dice check the same hand.
    const turn = dealt('nlhe', ['7c', 'As', '2d', 'Ah', 'Kd', 'Qs', '9h', '4h', '3s', '8c']);
    while (turn.street < 2) engine.act(turn, turn.toAct!, engine.legalActions(turn, turn.toAct!)!.canCheck ? { type: 'check' } : { type: 'call' });
    const legal = engine.legalActions(turn, turn.toAct!)!;
    const always: Dice = { roll: () => true, between: (_label, base, span) => base + span };
    const bot: MoveWhy = { rule: 'check' };
    expect(normalDecide(turn, turn.toAct!, legal, 0.05, 1, always, bot).type).toBe('bet');
    expect(bot.rule).toBe('bluff');
    const tip: MoveWhy = { rule: 'check' };
    expect(normalDecide(turn, turn.toAct!, legal, 0.05, 1, tipDice, tip)).toEqual({ type: 'check' });
    expect(tip.rule).toBe('check');
    // Whatever its chances, a tip bets or raises only for value: a half-pot bet, or three quarters of the pot as a raise.
    const facing = dealt('nlhe', ['7c', 'As', '2d', 'Ah']);
    engine.act(facing, 0, { type: 'raise', to: 8 });
    for (const [hand, seat] of [[turn, turn.toAct!], [facing, 1]] as [HandState, number][]) {
      for (let equity = 0; equity <= 1; equity += 0.05) {
        const why: MoveWhy = { rule: 'check' };
        const action = normalDecide(hand, seat, engine.legalActions(hand, seat)!, equity, 1, tipDice, why);
        expect(['bluff', 'steal', 'semi-bluff']).not.toContain(why.rule);
        if (action.type === 'bet' || action.type === 'raise') expect(['value', 'raise']).toContain(why.rule);
      }
    }
  });

  it('keep the turn-key hash the bots have always used', () => {
    const old = (key: string) => {
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h;
    };
    for (const key of ['t1-1:0', 'abc-123:45', 'x'.repeat(200), '']) expect(hashKey(key)).toBe(old(key));
    expect(hashKey('t1-1:0')).toBe(old('t1-1:0'));
  });
});

describe('what a seat sees (seenBy)', () => {
  const tuning = { ...botTuning };
  beforeAll(() => Object.assign(botTuning, { thinkMs: 0, minSims: 4, drawSims: 2, drawFinalSims: 3, drawBetSims: 2, drawBetFinalSims: 2 }));
  afterAll(() => Object.assign(botTuning, tuning));

  /** Every card the player in `seat` has been shown: their own (thrown ones too), up cards, boards and cards shown. */
  function visibleTo(hand: HandState, seat: number): Set<Card> {
    const out = new Set<Card>();
    for (const e of hand.events) {
      if (e.t === 'deal') for (const c of e.cards) if (c.up || e.seat === seat) out.add(c.card);
      if (e.t === 'draw' && e.seat === seat) for (const c of e.cards) out.add(c);
      if (e.t === 'board' || e.t === 'show') for (const c of e.cards) out.add(c);
    }
    return out;
  }

  function check(hand: HandState, seat: number) {
    const seen = seenBy(hand, seat);
    const json = JSON.stringify(seen);
    const visible = visibleTo(hand, seat);
    const cards = [...json.matchAll(/"([2-9TJQKA][cdhs])"/g)].map((m) => m[1]);
    expect(cards.filter((c) => !visible.has(c))).toEqual([]);
    for (const x of hand.seats) if (x.seat !== seat) for (const c of x.cards) if (!c.up) expect(json).not.toContain(`"${c.card}"`);
    for (const c of hand.input.deck.slice(hand.deckPos)) if (!visible.has(c)) expect(json).not.toContain(`"${c}"`);
    expect(hand.input.fair).toBeDefined();
    for (const secret of [hand.input.fair!.serverSeed, hand.input.fair!.handSeed]) expect(json).not.toContain(secret);
    expect(seen.input).not.toHaveProperty('fair');
    expect([seen.input.deck, seen.muck, seen.deckPos]).toEqual([[], [], 0]);
    expect(json).not.toContain('"pos"');
    // Others' draws keep how many they threw, never which ones.
    for (const e of seen.events) if (e.t === 'draw' && e.seat !== seat) expect(e).not.toHaveProperty('positions');
    // It plays the same: what the bot sees, how opponents have bet, and how many cards they drew.
    expect(situation(seen, seat)).toEqual(situation(hand, seat));
    expect(handReads(seen, seat, {})).toEqual(handReads(hand, seat, {}));
    expect(opponentDraws(seen, seat, 3)).toEqual(opponentDraws(hand, seat, 3));
  }

  for (const spec of VARIANT_LIST) {
    it(`holds only what that seat can see in ${spec.name}`, () => {
      const stud = spec.family === 'stud';
      const { rt, clock } = table((s) => {
        s.game.gameId = spec.id;
        s.table.maxSeats = 4;
        if (stud) Object.assign(s.stakes, { smallBlind: 0, bigBlind: 2, ante: 1, anteType: 'per-player', bringIn: 0 });
        s.timing.decisionSeconds = 0;
      });
      rt.requestSeat('host', { seat: 0, name: 'Host', stack: 300 });
      for (const level of BOT_LEVELS) rt.addBot('host', { ownerName: 'Host', level });
      rt.start('host');
      let checked = 0;
      for (let i = 0; i < 20_000 && rt.state.handNumber <= 3; i++) {
        const h = rt.state.hand;
        if (h && (h.phase === 'betting' || h.phase === 'drawing') && h.toAct !== null) {
          for (const x of h.seats) check(h, x.seat);
          checked++;
          if (rt.state.seats[h.toAct]?.playerId === 'host') {
            if (h.phase === 'drawing') rt.draw('host', [0]);
            else {
              const legal = engine.legalActions(h, h.toAct)!;
              rt.act('host', legal.canCheck ? { type: 'check' } : legal.canBringIn ? { type: 'bring-in' } : { type: 'call' });
            }
            continue;
          }
        }
        clock.advance(500);
      }
      expect(checked).toBeGreaterThan(5);
    });
  }
});
