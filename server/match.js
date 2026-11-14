import { randomInt, randomUUID } from 'node:crypto';
import { beats, classify, legalMoves, sortCards } from '../shared/rules.js';

export class GameError extends Error {}

export class Match {
  constructor(code, { now = Date.now, shuffle = shuffleDeck } = {}) {
    this.code = code;
    this.now = now;
    this.shuffle = shuffle;
    this.players = [];
    this.phase = 'lobby';
    this.version = 0;
    this.turn = 0;
    this.deadline = 0;
    this.landlord = -1;
    this.kitty = [];
    this.previous = null;
    this.lastPlayer = -1;
    this.passes = 0;
    this.bid = 0;
    this.bidder = -1;
    this.bidCount = 0;
    this.multiplier = 1;
    this.winner = null;
    this.message = 'Take a seat. The courtyard is open.';
    this.owner = null;
    this.round = 0;
  }

  addPlayer(name, bot = false) {
    if (this.phase !== 'lobby' || this.players.length === 3) throw new GameError('This room is already full or playing.');
    const player = { id: randomUUID(), name, bot, connected: !bot, hand: [], score: 0, plays: 0 };
    this.players.push(player);
    if (!this.owner && !bot) this.owner = player.id;
    this.version++;
    return player;
  }

  seat(id) {
    const seat = this.players.findIndex((player) => player.id === id);
    if (seat < 0) throw new GameError('You are not seated in this room.');
    return seat;
  }

  command(id, action) {
    const seat = this.seat(id);
    if (!action || typeof action.type !== 'string') throw new GameError('Invalid command.');
    if (action.type === 'start') {
      if (id !== this.owner) throw new GameError('Only the room owner can start.');
      if (!['lobby', 'finished'].includes(this.phase)) throw new GameError('A match is already in progress.');
      if (action.bots === true) {
        while (this.players.length < 3) this.addPlayer(`Courtyard bot ${this.players.length}`, true);
      }
      if (this.players.length !== 3) throw new GameError('Wait for three players, or choose Play with bots.');
      this.deal();
    } else {
      if (seat !== this.turn) throw new GameError('Wait for your turn.');
      if (action.type === 'bid') this.placeBid(seat, action.value);
      else if (action.type === 'play') this.play(seat, action.cards);
      else if (action.type === 'pass') this.pass(seat);
      else throw new GameError('Unknown command.');
    }
    this.version++;
  }

  deal() {
    const deck = this.shuffle();
    this.round++;
    this.players.forEach((player, index) => {
      player.hand = sortCards(deck.slice(index * 17, (index + 1) * 17));
      player.plays = 0;
    });
    this.kitty = deck.slice(51);
    this.phase = 'bidding';
    this.turn = (this.round - 1) % 3;
    this.landlord = -1;
    this.bid = 0;
    this.bidder = -1;
    this.bidCount = 0;
    this.previous = null;
    this.lastPlayer = -1;
    this.passes = 0;
    this.multiplier = 1;
    this.winner = null;
    this.message = 'Bid for the landlord role.';
    this.setDeadline();
  }

  setDeadline() {
    const player = this.players[this.turn];
    this.deadline = this.now() + (player.bot ? 1200 : player.connected ? 30000 : 10000);
  }

  placeBid(seat, value) {
    if (this.phase !== 'bidding') throw new GameError('Bidding has ended.');
    if (!Number.isInteger(value) || value < 0 || value > 3 || (value !== 0 && value <= this.bid)) throw new GameError('Bid higher than the current bid, or pass.');
    this.bidCount++;
    if (value > 0) {
      this.bid = value;
      this.bidder = seat;
    }
    this.message = `${this.players[seat].name} ${value ? `bid ${value}` : 'passed'}.`;
    if (value === 3 || this.bidCount === 3) {
      if (this.bidder < 0) {
        this.deal();
        this.message = 'Everyone passed. Dealing a fresh hand.';
        return;
      }
      this.landlord = this.bidder;
      this.turn = this.landlord;
      this.players[this.landlord].hand = sortCards([...this.players[this.landlord].hand, ...this.kitty]);
      this.phase = 'playing';
      this.message = `${this.players[this.landlord].name} is the landlord.`;
    } else this.turn = (seat + 1) % 3;
    this.setDeadline();
  }

  play(seat, cards) {
    if (this.phase !== 'playing') throw new GameError('The round is not in play.');
    const player = this.players[seat];
    if (!Array.isArray(cards) || cards.some((card) => !player.hand.includes(card))) throw new GameError('You can only play cards from your hand.');
    const shape = classify(cards);
    if (!shape) throw new GameError('That is not a legal card combination.');
    if (!beats(shape, this.previous?.shape)) throw new GameError('Play a stronger combination of the same type, a bomb, or the rocket.');
    player.hand = player.hand.filter((card) => !cards.includes(card));
    player.plays++;
    this.previous = { cards: sortCards(cards), shape, seat };
    this.lastPlayer = seat;
    this.passes = 0;
    if (['bomb', 'rocket'].includes(shape.kind)) this.multiplier *= 2;
    this.message = `${player.name} played ${shape.kind.replaceAll('-', ' ')}.`;
    if (!player.hand.length) {
      this.finish(seat);
      return;
    }
    this.turn = (seat + 1) % 3;
    this.setDeadline();
  }

  pass(seat) {
    if (this.phase !== 'playing') throw new GameError('The round is not in play.');
    if (!this.previous || this.lastPlayer === seat) throw new GameError('You must lead with a card combination.');
    this.passes++;
    this.message = `${this.players[seat].name} passed.`;
    this.turn = (seat + 1) % 3;
    if (this.passes === 2) {
      this.turn = this.lastPlayer;
      this.previous = null;
      this.passes = 0;
      this.message = `${this.players[this.turn].name} leads a new trick.`;
    }
    this.setDeadline();
  }

  finish(seat) {
    const landlordWins = seat === this.landlord;
    const spring = landlordWins
      ? this.players.every((player, i) => i === this.landlord || player.plays === 0)
      : this.players[this.landlord].plays === 1;
    if (spring) this.multiplier *= 2;
    const stake = this.bid * this.multiplier;
    this.players.forEach((player, index) => {
      player.score += (index === this.landlord ? 2 : -1) * (landlordWins ? 1 : -1) * stake;
    });
    this.phase = 'finished';
    this.winner = landlordWins ? 'landlord' : 'farmers';
    this.deadline = 0;
    this.message = `${landlordWins ? 'The landlord wins!' : 'The farmers win!'}${spring ? ' Spring bonus ×2.' : ''}`;
  }

  tick() {
    if (!['bidding', 'playing'].includes(this.phase) || this.now() < this.deadline) return false;
    const player = this.players[this.turn];
    if (this.phase === 'bidding') {
      const strength = player.hand.filter((card) => card >= 44).length;
      this.placeBid(this.turn, this.bid < 1 || (strength >= 5 && this.bid < 3) ? this.bid + 1 : 0);
    } else {
      const teammateLeading = this.previous && this.landlord !== this.turn && this.previous.seat !== this.landlord;
      const moves = teammateLeading ? [] : legalMoves(player.hand, this.previous?.shape);
      if (moves.length) this.play(this.turn, moves[0].cards);
      else this.pass(this.turn);
    }
    this.version++;
    return true;
  }

  view(id) {
    const seat = this.seat(id);
    return {
      code: this.code, version: this.version, phase: this.phase, seat, owner: this.owner,
      players: this.players.map((player, index) => ({
        id: player.id, name: player.name, bot: player.bot, connected: player.connected,
        count: player.hand.length, score: player.score,
        hand: index === seat || this.phase === 'finished' ? player.hand : undefined,
      })),
      turn: this.turn, deadline: this.deadline, serverNow: this.now(), landlord: this.landlord,
      kitty: this.landlord >= 0 ? this.kitty : [], previous: this.previous,
      bid: this.bid, multiplier: this.multiplier, winner: this.winner, message: this.message,
    };
  }
}

function shuffleDeck() {
  const deck = Array.from({ length: 54 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
