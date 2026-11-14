import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, GameError } from '../server/match.js';

function setup() {
  let time = 0;
  const match = new Match('ABC234', { now: () => time, shuffle: () => Array.from({ length: 54 }, (_, i) => i) });
  const players = ['Mina', 'Jun', 'Olive'].map((name) => match.addPlayer(name));
  match.command(players[0].id, { type: 'start' });
  return { match, players, advance: () => { time += 31000; } };
}

test('deals every card exactly once and keeps opponent hands and kitty private before bidding', () => {
  const { match, players } = setup();
  assert.equal(new Set([...match.players.flatMap((p) => p.hand), ...match.kitty]).size, 54);
  const view = JSON.parse(JSON.stringify(match.view(players[0].id)));
  assert.equal(view.players[0].hand.length, 17);
  assert.ok(!Object.hasOwn(view.players[1], 'hand'));
  assert.ok(!Object.hasOwn(view.players[2], 'hand'));
  assert.deepEqual(view.kitty, []);
  match.command(players[0].id, { type: 'bid', value: 3 });
  assert.equal(match.players[0].hand.length, 20);
  assert.equal(match.view(players[1].id).kitty.length, 3);
  assert.ok(!Object.hasOwn(JSON.parse(JSON.stringify(match.view(players[1].id))).players[0], 'hand'));
});

test('validates turns, increasing bids, room ownership, and all-pass redeals', () => {
  const { match, players } = setup();
  assert.throws(() => match.command(players[1].id, { type: 'bid', value: 1 }), GameError);
  assert.throws(() => match.command(players[1].id, { type: 'start' }), /owner/);
  for (const player of players) match.command(player.id, { type: 'bid', value: 0 });
  assert.equal(match.phase, 'bidding');
  assert.equal(match.round, 2);
  assert.equal(match.turn, 1);
  match.command(players[1].id, { type: 'bid', value: 2 });
  assert.throws(() => match.command(players[2].id, { type: 'bid', value: 2 }), /higher/);
});

test('illegal plays never remove cards and two passes restore the previous leader', () => {
  const { match, players } = setup();
  match.command(players[0].id, { type: 'bid', value: 3 });
  const before = [...players[0].hand];
  assert.throws(() => match.command(players[0].id, { type: 'play', cards: [0, 0] }), /legal/);
  assert.throws(() => match.command(players[0].id, { type: 'play', cards: [30] }), /your hand/);
  assert.throws(() => match.command(players[0].id, { type: 'pass' }), /lead/);
  assert.deepEqual(players[0].hand, before);
  match.command(players[0].id, { type: 'play', cards: [0] });
  match.command(players[1].id, { type: 'pass' });
  match.command(players[2].id, { type: 'pass' });
  assert.equal(match.turn, 0);
  assert.equal(match.previous, null);
  assert.throws(() => match.command(players[0].id, { type: 'pass' }), /lead/);
});

test('settlement applies spring and zero-sum team scoring; rematch resets transient state', () => {
  const { match, players } = setup();
  match.command(players[0].id, { type: 'bid', value: 3 });
  players[0].hand = [0];
  match.command(players[0].id, { type: 'play', cards: [0] });
  assert.equal(match.phase, 'finished');
  assert.equal(match.multiplier, 2);
  assert.deepEqual(players.map((p) => p.score), [12, -6, -6]);
  assert.equal(players.reduce((sum, p) => sum + p.score, 0), 0);
  match.command(players[0].id, { type: 'start' });
  assert.equal(match.phase, 'bidding');
  assert.equal(match.winner, null);
  assert.equal(match.multiplier, 1);
  assert.deepEqual(players.map((p) => p.score), [12, -6, -6]);
});

test('farmer victory awards both teammates and applies counter-spring', () => {
  const { match, players } = setup();
  match.command(players[0].id, { type: 'bid', value: 2 });
  match.command(players[1].id, { type: 'bid', value: 0 });
  match.command(players[2].id, { type: 'bid', value: 0 });
  match.command(players[0].id, { type: 'play', cards: [0] });
  players[1].hand = [20];
  match.command(players[1].id, { type: 'play', cards: [20] });
  assert.equal(match.winner, 'farmers');
  assert.deepEqual(players.map((p) => p.score), [-8, 4, 4]);
});

test('bomb and rocket multipliers stack without awarding spring after both farmers have played', () => {
  const { match, players } = setup();
  match.command(players[0].id, { type: 'bid', value: 3 });
  players[0].hand = [0, 1, 2, 3, 4, 52, 53];
  players[1].plays = 1;
  players[2].plays = 1;
  for (const cards of [[0, 1, 2, 3], [52, 53]]) {
    match.command(players[0].id, { type: 'play', cards });
    match.command(players[1].id, { type: 'pass' });
    match.command(players[2].id, { type: 'pass' });
  }
  match.command(players[0].id, { type: 'play', cards: [4] });
  assert.equal(match.multiplier, 4);
  assert.deepEqual(players.map((p) => p.score), [24, -12, -12]);
});

test('timeout automation completes 50 shuffled matches without deadlocks', () => {
  for (let run = 0; run < 50; run++) {
    let time = 0;
    const match = new Match('BOT234', { now: () => time });
    const owner = match.addPlayer('Owner');
    match.command(owner.id, { type: 'start', bots: true });
    let turns = 0;
    while (match.phase !== 'finished' && turns++ < 500) {
      time += 31000;
      assert.ok(match.tick());
    }
    assert.equal(match.phase, 'finished', `Match ${run} did not finish in ${turns} turns`);
    assert.equal(match.players.reduce((sum, p) => sum + p.score, 0), 0);
    assert.ok(match.players.some((p) => !p.hand.length));
  }
});
