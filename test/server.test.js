import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';

class Client {
  constructor(url, options) {
    this.socket = new WebSocket(url, options);
    this.messages = [];
    this.waiters = [];
    this.socket.on('error', () => {});
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.messages.push(message);
    });
  }
  next(type, filter = () => true) {
    const predicate = (message) => message.type === type && filter(message);
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== entry);
        reject(new Error(`Timed out waiting for ${type}. Queued: ${JSON.stringify(this.messages)}`));
      }, 4000);
      const entry = { predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } };
      this.waiters.push(entry);
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
}

async function setup(t, options = {}) {
  const game = createGameServer(options);
  await new Promise((resolve) => game.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.http.address().port}`;
  const clients = [];
  t.after(async () => { clients.forEach((client) => client.socket.terminate()); await game.close(); });
  const connect = async () => {
    const client = new Client(base.replace('http:', 'ws:') + '/ws');
    clients.push(client);
    await client.next('welcome');
    return client;
  };
  return { game, base, connect };
}

test('serves the application and local Three.js modules without exposing server files', async (t) => {
  const { base } = await setup(t);
  for (const file of ['/', '/app.js', '/style.css', '/tokens.css', '/table.js', '/shared/rules.js', '/vendor/three.module.js', '/vendor/three.core.js', '/sw.js', '/manifest.webmanifest', '/icon.svg']) {
    const response = await fetch(base + file);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  for (const icon of manifest.icons.filter((item) => item.type === 'image/png')) {
    const response = await fetch(base + icon.src);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
  for (const file of ['/server/index.js', '/package.json', '/.env', '/shared/%2e%2e%2fserver%2findex.js']) {
    assert.equal((await fetch(base + file)).status, 404, file);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('three real WebSocket clients play with private views, validation, deduplication, and reconnect', async (t) => {
  const { connect } = await setup(t, { hostingMode: 'dedicated' });
  const alice = await connect();
  alice.send({ type: 'create', name: 'Alice' });
  const session = await alice.next('session');
  const bob = await connect();
  bob.send({ type: 'join', name: 'Bob', code: session.code });
  await bob.next('session');
  const cy = await connect();
  cy.send({ type: 'join', name: 'Cy', code: session.code });
  await cy.next('session');
  const lobby = (await alice.next('state', ({ state }) => state.players.length === 3)).state;
  alice.send({ type: 'command', commandId: 'start', version: lobby.version, action: { type: 'start' } });
  await alice.next('ack');
  const bidding = (await alice.next('state', ({ state }) => state.phase === 'bidding')).state;
  assert.equal(bidding.players[0].hand.length, 17);
  assert.ok(!Object.hasOwn(bidding.players[1], 'hand'));
  assert.ok(!Object.hasOwn(bidding.players[2], 'hand'));
  assert.deepEqual(bidding.kitty, []);
  bob.send({ type: 'command', commandId: 'cheat', version: bidding.version, action: { type: 'bid', value: 3 } });
  assert.match((await bob.next('error')).message, /turn/);
  alice.send({ type: 'command', commandId: 'bid', version: bidding.version, action: { type: 'bid', value: 3 } });
  await alice.next('ack');
  const playing = (await alice.next('state', ({ state }) => state.phase === 'playing')).state;
  assert.equal(playing.players[0].hand.length, 20);
  const bobView = (await bob.next('state', ({ state }) => state.phase === 'playing')).state;
  assert.ok(!Object.hasOwn(bobView.players[0], 'hand'));
  assert.equal(bobView.players[1].hand.length, 17);
  alice.send({ type: 'command', commandId: 'bid', version: bidding.version, action: { type: 'bid', value: 3 } });
  assert.equal((await alice.next('ack')).commandId, 'bid');
  alice.send({ type: 'command', commandId: 'stale', version: bidding.version, action: { type: 'play', cards: [0] } });
  assert.match((await alice.next('error')).message, /changed/);
  const expectedHand = playing.players[0].hand;
  alice.socket.close();
  await new Promise((resolve) => alice.socket.once('close', resolve));
  const resumed = await connect();
  resumed.send({ type: 'resume', token: session.token });
  await resumed.next('session');
  const restored = (await resumed.next('state')).state;
  assert.deepEqual(restored.players[0].hand, expectedHand);
  resumed.send({ type: 'command', commandId: 'play', version: restored.version, action: { type: 'play', cards: [expectedHand[0]] } });
  await resumed.next('ack');
  assert.equal((await resumed.next('state')).state.players[0].count, 19);
});

test('player-hosted rooms can start with bots; room owners hand over on departure', async (t) => {
  const { connect } = await setup(t);
  const owner = await connect();
  owner.send({ type: 'create', name: 'Host' });
  const session = await owner.next('session');
  const friend = await connect();
  friend.send({ type: 'join', code: session.code, name: 'Friend' });
  const friendSession = await friend.next('session');
  await owner.next('state', ({ state }) => state.players.length === 2);
  owner.send({ type: 'leave' });
  await owner.next('left');
  const lobby = (await friend.next('state', ({ state }) => state.players.length === 1)).state;
  assert.equal(lobby.owner, friendSession.playerId);
  friend.send({ type: 'command', commandId: 'bots', version: lobby.version, action: { type: 'start', bots: true } });
  await friend.next('ack');
  const bidding = (await friend.next('state', ({ state }) => state.phase === 'bidding')).state;
  assert.equal(bidding.players.filter((p) => p.bot).length, 2);
});

test('expired sessions and malformed messages fail explicitly, without crashing', async (t) => {
  const { connect } = await setup(t);
  const client = await connect();
  client.socket.send('not-json');
  assert.match((await client.next('error')).message, /JSON/);
  client.send({ type: 'resume', token: 'missing' });
  assert.equal((await client.next('error')).code, 'SESSION_EXPIRED');
  client.send({ type: 'create', name: '' });
  assert.match((await client.next('error')).message, /name/);
  client.send({ type: 'create', name: 'Still connected' });
  await client.next('session');
});

test('empty rooms expire together with their resume credentials', async (t) => {
  const { connect, game } = await setup(t, { emptyRoomMs: 1 });
  const owner = await connect();
  owner.send({ type: 'create', name: 'Temporary host' });
  const session = await owner.next('session');
  owner.socket.close();
  await new Promise((resolve) => owner.socket.once('close', resolve));
  const deadline = Date.now() + 3000;
  while (game.rooms.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(game.rooms.size, 0);
  const returning = await connect();
  returning.send({ type: 'resume', token: session.token });
  assert.equal((await returning.next('error')).code, 'SESSION_EXPIRED');
});

test('rejects cross-origin browser WebSocket connections', async (t) => {
  const { base } = await setup(t);
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws', { origin: 'https://unrelated.example' });
  const error = await new Promise((resolve) => socket.once('error', resolve));
  assert.match(error.message, /403/);
});
