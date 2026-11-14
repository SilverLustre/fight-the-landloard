import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { GameError, Match } from './match.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cleanName = (name) => {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 20 || /[\p{C}]/u.test(name)) {
    throw new GameError('Use a name between 1 and 20 characters, without control characters.');
  }
  return name.trim();
};

export function createGameServer({ hostingMode = 'player', publicOrigin, maxRooms = 200, emptyRoomMs = 120000 } = {}) {
  const rooms = new Map();
  const sessions = new Map();
  const clients = new Set();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const http = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size, hostingMode }));
        return;
      }
      let base = resolve(ROOT, 'public');
      let relative = path === '/' ? 'index.html' : path.slice(1);
      if (path.startsWith('/shared/')) {
        base = resolve(ROOT, 'shared');
        relative = path.slice('/shared/'.length);
      } else if (['/vendor/three.module.js', '/vendor/three.core.js'].includes(path)) {
        base = resolve(ROOT, 'node_modules/three/build');
        relative = path.slice('/vendor/'.length);
      }
      const file = resolve(base, relative);
      if (!file.startsWith(`${base}${sep}`) || !TYPES[extname(file)]) {
        res.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': `${TYPES[extname(file)]}${extname(file) === '.png' ? '' : '; charset=utf-8'}`,
        'Cache-Control': 'no-cache',
        ...(path === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR' || error instanceof URIError) res.writeHead(404).end('Not found');
      else {
        console.error('HTTP request failed:', error);
        res.writeHead(500).end('Request failed');
      }
    }
  });

  const send = (socket, message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const broadcast = (room) => {
    for (const session of sessions.values()) {
      if (session.room === room && session.socket) send(session.socket, { type: 'state', state: room.match.view(session.player.id) });
    }
  };
  const attach = (socket, session) => {
    if (socket.session && socket.session !== session) throw new GameError('You are already in a room. Leave before joining another.');
    if (session.socket && session.socket !== socket) {
      session.socket.session = null;
      session.socket.close(4001, 'Session resumed elsewhere');
    }
    socket.session = session;
    session.socket = socket;
    session.player.connected = true;
    session.room.emptySince = null;
    session.room.match.version++;
    send(socket, { type: 'session', token: session.token, code: session.room.match.code, playerId: session.player.id });
    broadcast(session.room);
  };

  http.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === publicOrigin || [`http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin);
    if (req.url !== '/ws' || !sameOrigin || clients.size >= maxRooms * 6) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(req, socket, head, (client) => websocket.emit('connection', client));
  });
  websocket.on('connection', (socket) => {
    clients.add(socket);
    socket.alive = true;
    socket.windowStart = Date.now();
    socket.count = 0;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('error', (error) => console.warn('WebSocket transport error:', error.message));
    send(socket, { type: 'welcome', hostingMode });
    socket.on('message', (raw, binary) => {
      let commandId;
      try {
        if (Date.now() - socket.windowStart > 10000) {
          socket.windowStart = Date.now();
          socket.count = 0;
        }
        if (++socket.count > 40) throw new GameError('Too many requests. Wait a moment.');
        if (binary) throw new GameError('Only JSON messages are accepted.');
        let message;
        try { message = JSON.parse(raw.toString()); }
        catch { throw new GameError('Invalid JSON message.'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new GameError('Invalid message.');
        if (['create', 'join', 'resume'].includes(message.type)) {
          if (socket.session) throw new GameError('You are already in a room.');
          if (message.type === 'resume') {
            const session = typeof message.token === 'string' && sessions.get(message.token);
            if (!session) {
              const error = new GameError('This session has expired. Join a new room.');
              error.code = 'SESSION_EXPIRED';
              throw error;
            }
            attach(socket, session);
            return;
          }
          const name = cleanName(message.name);
          let room;
          if (message.type === 'create') {
            if (rooms.size >= maxRooms) throw new GameError('The server is full. Try again later.');
            let code;
            do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
            room = { match: new Match(code), emptySince: null };
            rooms.set(code, room);
          } else {
            if (typeof message.code !== 'string' || !/^[A-Z2-9]{6}$/.test(message.code.toUpperCase())) throw new GameError('Enter a six-character room code.');
            room = rooms.get(message.code.toUpperCase());
            if (!room) throw new GameError('Room not found on this server.');
          }
          const player = room.match.addPlayer(name);
          const token = randomBytes(32).toString('hex');
          const session = { token, room, player, socket: null, commands: new Set() };
          sessions.set(token, session);
          attach(socket, session);
        } else if (message.type === 'command') {
          const session = socket.session;
          if (!session) throw new GameError('Join a room first.');
          commandId = message.commandId;
          if (typeof commandId !== 'string' || commandId.length > 80 || !commandId.length) throw new GameError('A command ID is required.');
          if (session.commands.has(commandId)) {
            send(socket, { type: 'ack', commandId });
            return;
          }
          if (message.version !== session.room.match.version) throw new GameError('The table changed. Please try again.');
          session.room.match.command(session.player.id, message.action);
          session.commands.add(commandId);
          if (session.commands.size > 200) session.commands.delete(session.commands.values().next().value);
          send(socket, { type: 'ack', commandId });
          broadcast(session.room);
        } else if (message.type === 'leave') {
          const session = socket.session;
          if (!session) throw new GameError('You are not in a room.');
          if (['lobby', 'finished'].includes(session.room.match.phase)) {
            const match = session.room.match;
            const index = match.seat(session.player.id);
            match.players.splice(index, 1);
            if (match.owner === session.player.id) match.owner = match.players.find((p) => !p.bot)?.id ?? null;
            // After settlement, discard hands before opening the seats again.
            match.phase = 'lobby';
            match.players.forEach((p) => { p.hand = []; });
            match.kitty = [];
            match.landlord = -1;
            match.previous = null;
            match.deadline = 0;
            match.message = 'A seat is open. Invite a friend.';
            match.version++;
            sessions.delete(session.token);
          }
          session.player.connected = false;
          session.socket = null;
          socket.session = null;
          if (session.room.match.owner === session.player.id) session.room.match.owner = session.room.match.players.find((p) => !p.bot && p.connected)?.id ?? session.player.id;
          session.room.match.version++;
          if (!session.room.match.players.some((p) => !p.bot && p.connected)) session.room.emptySince = Date.now();
          send(socket, { type: 'left' });
          broadcast(session.room);
        } else throw new GameError('Unknown message type.');
      } catch (error) {
        if (!(error instanceof GameError)) console.error('Command failed:', error);
        send(socket, { type: 'error', commandId, code: error.code, message: error instanceof GameError ? error.message : 'The server could not process that action.' });
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
      const session = socket.session;
      if (!session || session.socket !== socket) return;
      session.socket = null;
      session.player.connected = false;
      if (session.room.match.owner === session.player.id) session.room.match.owner = session.room.match.players.find((p) => !p.bot && p.connected)?.id ?? session.player.id;
      session.room.match.version++;
      if (!session.room.match.players.some((player) => !player.bot && player.connected)) session.room.emptySince = Date.now();
      broadcast(session.room);
    });
  });

  const timer = setInterval(() => {
    for (const [code, room] of rooms) {
      if (room.emptySince !== null && Date.now() - room.emptySince >= emptyRoomMs) {
        for (const [token, session] of sessions) if (session.room === room) sessions.delete(token);
        rooms.delete(code);
      } else if (room.match.tick()) broadcast(room);
    }
  }, 250);
  const heartbeat = setInterval(() => {
    for (const socket of clients) {
      if (!socket.alive) socket.terminate();
      else { socket.alive = false; socket.ping(); }
    }
  }, 30000);

  return {
    http, rooms,
    close: async () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const socket of clients) socket.terminate();
      await new Promise((resolveClose) => websocket.close(resolveClose));
      await new Promise((resolveClose, reject) => http.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const hostingMode = process.env.HOSTING_MODE ?? 'player';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['player', 'dedicated'].includes(hostingMode)) {
    console.error('PORT must be 1–65535 and HOSTING_MODE must be player or dedicated.');
    process.exitCode = 1;
  } else {
    const game = createGameServer({ hostingMode, publicOrigin: process.env.PUBLIC_ORIGIN });
    game.http.on('error', (error) => { console.error('Cannot start server:', error.message); process.exitCode = 1; game.close().catch(console.error); });
    game.http.listen(port, host, () => {
      console.log(`Fight the Landlord · ${hostingMode} server · http://${host}:${port}`);
      if (host === '0.0.0.0') console.log('LAN hosting enabled. Share this computer’s LAN IP, not 0.0.0.0. Internet play requires a reachable endpoint or tunnel.');
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      game.close().catch((error) => { console.error('Shutdown failed:', error); process.exitCode = 1; });
    });
  }
}
