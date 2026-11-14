import test from 'node:test';
import assert from 'node:assert/strict';
import { beats, classify, legalMoves } from '../shared/rules.js';

function cards(...values) {
  const used = new Map();
  return values.map((value) => {
    const offset = used.get(value) ?? 0;
    used.set(value, offset + 1);
    return value >= 16 ? value + 36 : (value - 3) * 4 + offset;
  });
}

test('recognizes all supported combinations and their main ranks', () => {
  const cases = [
    [[3], 'single', 3], [[15, 15], 'pair', 15], [[4, 4, 4], 'triple', 4],
    [[6, 6, 6, 3], 'triple-single', 6], [[6, 6, 6, 3, 3], 'triple-pair', 6],
    [[3, 4, 5, 6, 7], 'straight', 7], [[3, 3, 4, 4, 5, 5], 'pair-run', 5],
    [[3, 3, 3, 4, 4, 4], 'airplane', 4],
    [[3, 3, 3, 4, 4, 4, 6, 8], 'airplane-singles', 4],
    [[3, 3, 3, 4, 4, 4, 6, 6, 8, 8], 'airplane-pairs', 4],
    [[7, 7, 7, 7], 'bomb', 7], [[16, 17], 'rocket', 17],
    [[7, 7, 7, 7, 3, 5], 'four-singles', 7],
    [[7, 7, 7, 7, 3, 3, 5, 5], 'four-pairs', 7],
  ];
  for (const [values, kind, main] of cases) assert.deepEqual(classify(cards(...values)), { kind, main, size: values.length });
});

test('rejects duplicate IDs, invalid IDs, short runs, twos in runs, and repeated single wings', () => {
  for (const hand of [[], [0, 0], [-1], [54], ['0'], [0.1], cards(3, 4, 5, 6), cards(11, 12, 13, 14, 15),
    cards(3, 3, 3, 4, 4, 4, 6, 6), cards(7, 7, 7, 7, 3, 3), cards(3, 3, 4)]) {
    assert.equal(classify(hand), null, JSON.stringify(hand));
  }
  assert.equal(classify(null), null);
});

test('comparison enforces shape and length, bomb precedence, and unbeatable rocket', () => {
  const shape = (...values) => classify(cards(...values));
  assert.ok(beats(shape(4), shape(3)));
  assert.ok(!beats(shape(3), shape(3)));
  assert.ok(!beats(shape(4, 4), shape(3)));
  assert.ok(!beats(shape(4, 5, 6, 7, 8, 9), shape(3, 4, 5, 6, 7)));
  assert.ok(beats(shape(3, 3, 3, 3), shape(15, 15, 15)));
  assert.ok(beats(shape(4, 4, 4, 4), shape(3, 3, 3, 3)));
  assert.ok(beats(shape(16, 17), shape(15, 15, 15, 15)));
  assert.ok(!beats(shape(16, 17), shape(16, 17)));
});

test('hints generate legal responses without inventing cards, including winged airplanes', () => {
  const hand = cards(3, 3, 3, 4, 4, 4, 6, 6, 8, 8, 9, 9, 9, 9, 16, 17);
  const leading = legalMoves(hand);
  for (const kind of ['single', 'pair', 'triple', 'triple-single', 'triple-pair', 'airplane',
    'airplane-singles', 'airplane-pairs', 'bomb', 'four-singles', 'four-pairs', 'rocket']) {
    assert.ok(leading.some((move) => move.kind === kind), kind);
  }
  for (const previous of [null, classify(cards(3)), classify(cards(5, 5)), classify(cards(5, 5, 5, 5))]) {
    for (const move of legalMoves(hand, previous)) {
      assert.ok(move.cards.every((card) => hand.includes(card)));
      assert.equal(new Set(move.cards).size, move.cards.length);
      assert.ok(beats(classify(move.cards), previous));
    }
  }
});
