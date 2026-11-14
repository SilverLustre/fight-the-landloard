// Card IDs are stable on the wire; suits never affect combination strength.
export const rank = (card) => card < 52 ? Math.floor(card / 4) + 3 : card - 36;
export const rankName = (value) => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'LJ', 17: 'HJ' })[value] ?? String(value);
export const suit = (card) => card < 52 ? ['♠', '♥', '♣', '♦'][card % 4] : '★';
export const cardName = (card) => `${rankName(rank(card))}${suit(card)}`;
export const sortCards = (cards) => [...cards].sort((a, b) => rank(a) - rank(b) || a - b);

function groups(cards) {
  const result = new Map();
  for (const card of sortCards(cards)) {
    const value = rank(card);
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(card);
  }
  return result;
}

const consecutive = (values) => values.at(-1) <= 14 && values.every((v, i) => i === 0 || v === values[i - 1] + 1);
const combo = (kind, main, size) => ({ kind, main, size });

export function classify(cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 20 ||
      cards.some((c) => !Number.isInteger(c) || c < 0 || c > 53) ||
      new Set(cards).size !== cards.length) return null;
  const entries = [...groups(cards)];
  const values = entries.map(([value]) => value);
  const counts = entries.map(([, list]) => list.length);
  const n = cards.length;
  if (n === 1) return combo('single', values[0], n);
  if (n === 2 && values[0] === 16 && values[1] === 17) return combo('rocket', 17, n);
  if (entries.length === 1) return combo(({ 2: 'pair', 3: 'triple', 4: 'bomb' })[n], values[0], n);
  if (n === 4 && counts.includes(3)) return combo('triple-single', values[counts.indexOf(3)], n);
  if (n === 5 && counts.includes(3) && counts.includes(2)) return combo('triple-pair', values[counts.indexOf(3)], n);
  if (n >= 5 && entries.length === n && consecutive(values)) return combo('straight', values.at(-1), n);
  if (n >= 6 && n % 2 === 0 && counts.every((c) => c === 2) && consecutive(values)) return combo('pair-run', values.at(-1), n);
  if (n >= 6 && n % 3 === 0 && counts.every((c) => c === 3) && consecutive(values)) return combo('airplane', values.at(-1), n);
  const four = counts.indexOf(4);
  if (four >= 0) {
    const wings = counts.filter((_, i) => i !== four);
    if (n === 6 && wings.length === 2 && wings.every((c) => c === 1)) return combo('four-singles', values[four], n);
    if (n === 8 && wings.length === 2 && wings.every((c) => c === 2)) return combo('four-pairs', values[four], n);
  }
  for (const wingSize of [1, 2]) {
    const width = n / (3 + wingSize);
    if (!Number.isInteger(width) || width < 2) continue;
    const triples = entries.filter(([, list]) => list.length === 3).map(([v]) => v);
    for (let i = 0; i + width <= triples.length; i++) {
      const core = triples.slice(i, i + width);
      if (!consecutive(core)) continue;
      const wings = entries.filter(([v]) => !core.includes(v));
      if (wings.length === width && wings.every(([, list]) => list.length === wingSize)) {
        return combo(wingSize === 1 ? 'airplane-singles' : 'airplane-pairs', core.at(-1), n);
      }
    }
  }
  return null;
}

export function beats(candidate, previous) {
  if (!candidate) return false;
  if (!previous) return true;
  if (previous.kind === 'rocket') return false;
  if (candidate.kind === 'rocket') return true;
  if (candidate.kind === 'bomb' && previous.kind !== 'bomb') return true;
  return candidate.kind === previous.kind && candidate.size === previous.size && candidate.main > previous.main;
}

function choose(items, count) {
  if (count === 0) return [[]];
  if (items.length < count) return [];
  return items.flatMap((item, index) => choose(items.slice(index + 1), count - 1).map((tail) => [item, ...tail]));
}

// Generate by rank groups rather than all subsets of a 20-card hand.
export function legalMoves(hand, previous = null) {
  const entries = [...groups(hand)];
  const candidates = new Map();
  const add = (cards) => {
    const sorted = sortCards(cards);
    const kind = classify(sorted);
    if (beats(kind, previous)) candidates.set(sorted.join(','), { cards: sorted, ...kind });
  };
  for (const [, cards] of entries) {
    for (let size = 1; size <= cards.length; size++) add(cards.slice(0, size));
    if (cards.length >= 3) {
      for (const [, wing] of entries.filter(([v]) => v !== rank(cards[0]))) {
        add([...cards.slice(0, 3), wing[0]]);
        if (wing.length >= 2) add([...cards.slice(0, 3), ...wing.slice(0, 2)]);
      }
    }
    if (cards.length === 4) {
      for (const size of [1, 2]) {
        const wings = entries.filter(([v, list]) => v !== rank(cards[0]) && list.length >= size);
        for (const pair of choose(wings, 2)) add([...cards, ...pair.flatMap(([, list]) => list.slice(0, size))]);
      }
    }
  }
  if (hand.includes(52) && hand.includes(53)) add([52, 53]);
  for (const copies of [1, 2, 3]) {
    const min = copies === 1 ? 5 : copies === 2 ? 3 : 2;
    const eligible = entries.filter(([v, list]) => v <= 14 && list.length >= copies);
    for (let start = 0; start < eligible.length; start++) {
      for (let end = start + min; end <= eligible.length; end++) {
        const run = eligible.slice(start, end);
        if (!consecutive(run.map(([v]) => v))) break;
        const core = run.flatMap(([, list]) => list.slice(0, copies));
        add(core);
        if (copies !== 3) continue;
        const coreRanks = run.map(([v]) => v);
        for (const size of [1, 2]) {
          const wings = entries.filter(([v, list]) => !coreRanks.includes(v) && list.length >= size);
          for (const selection of choose(wings, run.length)) add([...core, ...selection.flatMap(([, list]) => list.slice(0, size))]);
        }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => {
    const cost = (move) => (move.kind === 'rocket' ? 200 : move.kind === 'bomb' ? 100 : 0);
    return cost(a) - cost(b) || b.size - a.size || a.main - b.main;
  });
}
