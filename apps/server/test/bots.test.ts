import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engine, variants, type BettingKind } from '@rsdp/engine/core';
import { defaultSettings, type TableSettings } from '@rsdp/engine/settings';
import { getVariant, registerAllVariants, VARIANT_LIST } from '@rsdp/engine/variants';
import { BOT_THINK_MS, HOST_HANDOFF_MS, TableRuntime } from '../src/runtime/table';
import { handRecordView, tableView } from '../src/runtime/view';
import { BOT_LOOKS } from '@rsdp/engine/wire';
import { botTuning, chooseMove, seededRand } from '../src/bots/strategy';
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
    // Bo asks to sit as "ace": the seated bot takes another name, and so does the waiting one when Cy wants "Chip".
    rt.requestSeat('b', { seat: 6, name: 'ace', stack: 200 });
    expect(rt.seatOf(seated)?.name).toBe('Lucky');
    expect(rt.state.log.at(-1)?.text).toBe('Ace is now Lucky');
    rt.connect('c');
    rt.requestSeat('c', { seat: 7, name: 'CHIP', stack: 200 });
    expect(rt.state.requests.find((r) => r.playerId === waiting)?.name).toBe('Ducky');

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
    expect(tableView(back, 'host', 0).seats[2]?.bot).toEqual({ ownerId: 'host', ownerName: 'Beth', look: 1 });
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
        for (let i = 0; i < Math.min(spec.maxPlayers, 6) - 1; i++) rt.addBot('host', { ownerName: 'Host' });
        rt.start('host');
        play(rt, clock, 12);
        expect(errors).toEqual([]);
        expect(chips(rt)).toBe(ledgerIn(rt));
      });
    }
  }
});

describe('bot strategy', () => {
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
