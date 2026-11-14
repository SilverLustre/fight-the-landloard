import { beats, classify, legalMoves, rank, rankName, suit } from '/shared/rules.js';

const $ = (id) => document.getElementById(id);
let state = null;
let socket;
let scene;
let token = null;
let pending = false;
let pendingTimer;
let reconnectTimer;
let reconnectAttempt = 0;
let reconnectStarted = 0;
let selected = new Set();
let hintIndex = 0;
let drag = null;
let practiceAfterCreate = false;
let lastVersion = -1;
let lastPhase;
let clockOffset = 0;
let audio;
let installPrompt;
let toastTimer;
let lastHostingMode = 'player';
const memory = new Map();

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000);
}

function store(key, value, session = false) {
  memory.set(key, value);
  try {
    const storage = session ? sessionStorage : localStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch (error) {
    console.warn('Browser storage is unavailable; preferences/session will last only in this page.', error);
    toast('Browser storage is unavailable. Reloading may lose your seat.');
  }
}

function read(key, session = false) {
  try { return (session ? sessionStorage : localStorage).getItem(key); }
  catch (error) {
    console.warn('Cannot read browser storage:', error);
    return memory.get(key) ?? null;
  }
}

const options = {
  reducedMotion: read('reducedMotion') === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches,
  lowPower: read('lowPower') === 'true',
  sound: read('sound') === 'true',
};
token = read('courtyard-session', true);
$('player-name').value = read('courtyard-name') ?? '';
$('room-code').value = new URLSearchParams(location.search).get('room')?.slice(0, 6).toUpperCase() ?? '';

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) {
    toast('The server is disconnected. Reconnect before continuing.');
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function command(action) {
  if (pending || !state) return;
  const commandId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (!send({ type: 'command', commandId, version: state.version, action })) return;
  pending = true;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pending = false;
    toast('The server has not confirmed your action. Reconnecting to sync the table.');
    socket.close(4000, 'Command timeout');
    render();
  }, 8000);
  renderControls();
}

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  $('connection').classList.add('offline');
  $('connection').lastChild.textContent = reconnectAttempt ? 'Reconnecting' : 'Connecting';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket.onopen = () => {
    reconnectAttempt = 0;
    reconnectStarted = 0;
    $('connection').classList.remove('offline');
    $('connection').lastChild.textContent = 'Connected';
    $('reconnect').classList.add('hidden');
    renderControls();
    if (token) send({ type: 'resume', token });
  };
  socket.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); }
    catch (error) {
      console.error('Malformed server response:', error);
      toast('Received an unreadable server response. Reconnect to sync.');
      return;
    }
    if (message.type === 'welcome') {
      lastHostingMode = message.hostingMode;
      $('hosting-label').textContent = `${lastHostingMode.toUpperCase()} SERVER`;
    } else if (message.type === 'session') {
      token = message.token;
      store('courtyard-session', token, true);
    } else if (message.type === 'state') {
      if (state?.code === message.state.code && message.state.version < lastVersion) return;
      state = message.state;
      lastVersion = state.version;
      clockOffset = state.serverNow - Date.now();
      const hand = state.players[state.seat].hand;
      selected = new Set([...selected].filter((card) => hand.includes(card)));
      if (lastPhase !== 'finished' && state.phase === 'finished') {
        scene?.celebrate();
        playSound(true);
      }
      if (state.previous?.shape && ['bomb', 'rocket'].includes(state.previous.shape.kind) && lastPhase === 'playing') scene?.celebrate();
      lastPhase = state.phase;
      render();
      if (practiceAfterCreate && state.phase === 'lobby') {
        practiceAfterCreate = false;
        command({ type: 'start', bots: true });
      }
    } else if (message.type === 'ack') {
      clearTimeout(pendingTimer);
      pending = false;
      playSound(false);
      renderControls();
    } else if (message.type === 'left') {
      resetRoom();
    } else if (message.type === 'error') {
      clearTimeout(pendingTimer);
      pending = false;
      practiceAfterCreate = false;
      toast(message.message);
      if (message.code === 'SESSION_EXPIRED') resetRoom();
      else if (!state && token) {
        token = null;
        store('courtyard-session', null, true);
      }
      renderControls();
    }
  };
  socket.onclose = ({ code }) => {
    clearTimeout(pendingTimer);
    pending = false;
    $('connection').classList.add('offline');
    $('connection').lastChild.textContent = 'Disconnected';
    renderControls();
    if (code === 4001) {
      resetRoom();
      toast('Your seat was opened in another window.');
      $('reconnect').classList.remove('hidden');
      return;
    }
    reconnectStarted ||= Date.now();
    if (Date.now() - reconnectStarted < 120000) {
      reconnectTimer = setTimeout(connect, Math.min(8000, 800 * 2 ** reconnectAttempt++));
    } else {
      toast('Cannot reach the host. Your room may have ended. Reconnect when the host is available.');
      $('reconnect').classList.remove('hidden');
    }
  };
  socket.onerror = () => {
    $('connection').lastChild.textContent = 'Connection failed';
  };
}

function resetRoom() {
  token = null;
  state = null;
  lastVersion = -1;
  lastPhase = null;
  selected.clear();
  store('courtyard-session', null, true);
  render();
}

function createRoom(practice = false) {
  if (!$('player-name').checkValidity()) {
    if (practice && !$('player-name').value.trim()) $('player-name').value = 'Guest';
    else { $('player-name').reportValidity(); return; }
  }
  store('courtyard-name', $('player-name').value.trim());
  practiceAfterCreate = practice;
  send({ type: 'create', name: $('player-name').value });
}

function cardElement(card, small = false) {
  const element = document.createElement(small ? 'div' : 'button');
  element.className = `card${card < 52 && [1, 3].includes(card % 4) || card === 53 ? ' red' : ''}`;
  const label = `${rankName(rank(card))} ${suit(card)}`;
  element.setAttribute('aria-label', label);
  const value = document.createElement('span');
  value.textContent = rankName(rank(card));
  const pip = document.createElement('span');
  pip.className = 'pip';
  pip.textContent = suit(card);
  element.append(value, pip);
  if (!small) {
    element.type = 'button';
    element.dataset.card = card;
    element.setAttribute('aria-pressed', selected.has(card));
    element.classList.toggle('selected', selected.has(card));
    const center = document.createElement('span');
    center.className = 'center-pip';
    center.textContent = suit(card);
    center.setAttribute('aria-hidden', 'true');
    element.append(center);
    let mouseSelected = false;
    element.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      mouseSelected = true;
      drag = !selected.has(card);
      selectCard(card, drag);
    });
    element.addEventListener('pointerenter', (event) => {
      if (drag !== null && event.buttons === 1 && event.pointerType === 'mouse') selectCard(card, drag);
    });
    element.addEventListener('click', () => {
      if (mouseSelected) { mouseSelected = false; return; }
      selectCard(card, !selected.has(card));
    });
  }
  return element;
}

function selectCard(card, active) {
  if (active) selected.add(card);
  else selected.delete(card);
  const element = $('hand').querySelector(`[data-card="${card}"]`);
  element?.classList.toggle('selected', active);
  element?.setAttribute('aria-pressed', active);
  renderControls();
}

function render() {
  const inRoom = Boolean(state);
  document.body.classList.toggle('playing', inRoom);
  $('home').classList.toggle('hidden', inRoom);
  $('game').classList.toggle('hidden', !inRoom);
  scene?.setGame(inRoom);
  if (!state) { renderControls(); return; }
  const you = state.players[state.seat];
  $('table-code').textContent = state.code;
  $('your-name').textContent = `${you.name} · You`;
  $('your-role').textContent = state.landlord < 0 ? `Unassigned · ${you.score} points` : `${state.landlord === state.seat ? '♛ Landlord' : '♧ Farmer'} · ${you.score} points`;
  $('opponents').replaceChildren();
  for (const offset of [1, 2]) {
    const index = (state.seat + offset) % 3;
    const player = state.players[index];
    const panel = document.createElement('div');
    panel.className = `player${player && state.turn === index && ['playing', 'bidding'].includes(state.phase) ? ' active' : ''}`;
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = player ? (index === state.landlord ? '♛' : offset === 1 ? '☺' : '☻') : '+';
    const info = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = player?.name ?? 'An open seat';
    const role = document.createElement('small');
    role.textContent = player ? `${player.bot ? 'BOT' : player.connected ? 'ONLINE' : 'RECONNECTING'} · ${state.landlord < 0 ? 'Unassigned' : index === state.landlord ? 'Landlord' : 'Farmer'} · ${player.score} pts` : 'Invite a friend to join';
    info.append(name, role);
    const count = document.createElement('span');
    count.className = 'card-count';
    count.textContent = player?.count ? `${player.count}` : '—';
    if (player) count.setAttribute('aria-label', `${player.count} cards remaining`);
    panel.append(avatar, info, count);
    $('opponents').append(panel);
  }
  $('phase').textContent = ({ lobby: 'WAITING FOR FRIENDS', bidding: 'WHO WILL BE THE LANDLORD?', playing: 'THE ROUND IS ON', finished: 'A ROUND WELL PLAYED' })[state.phase];
  $('table-message').textContent = state.message;
  $('round-details').textContent = state.phase === 'lobby'
    ? 'Share this server’s address and your table code.'
    : `Winning bid ${state.bid || '—'}  ·  Multiplier ×${state.multiplier}`;
  $('kitty').replaceChildren();
  if (state.phase !== 'lobby') {
    for (let i = 0; i < 3; i++) {
      const card = state.kitty.length ? cardElement(state.kitty[i], true) : document.createElement('div');
      if (!state.kitty.length) { card.className = 'card back'; card.setAttribute('aria-label', 'Hidden bonus card'); }
      $('kitty').append(card);
    }
  }
  $('played-cards').replaceChildren(...(state.previous?.cards ?? []).map((card) => cardElement(card, true)));
  const scroll = $('hand').scrollLeft;
  $('hand').replaceChildren(...you.hand.map((card) => cardElement(card)));
  $('hand').scrollLeft = scroll;
  fitHand();
  const finished = state.phase === 'finished';
  $('result').classList.toggle('hidden', !finished);
  $('result').textContent = finished ? state.players.map((player) => `${player.name}: ${player.score} pts`).join(' · ') : '';
  $('start-game').textContent = finished ? 'Play another round' : 'Start round';
  $('turn-label').textContent = ['bidding', 'playing'].includes(state.phase)
    ? state.turn === state.seat ? 'Your turn. Make it count.' : `${state.players[state.turn].name}’s turn`
    : state.phase === 'lobby' ? `${state.players.length}/3 seats filled` : 'Fancy another?';
  renderControls();
  updateClock();
}

function renderControls() {
  const online = socket?.readyState === WebSocket.OPEN;
  for (const id of ['create-room', 'join-room', 'practice']) $(id).disabled = !online;
  if (!state) return;
  const yourTurn = state.turn === state.seat && online && !pending;
  const idle = ['lobby', 'finished'].includes(state.phase);
  const owner = state.owner === state.players[state.seat].id;
  $('lobby-actions').classList.toggle('hidden', !idle || !owner);
  $('start-game').disabled = !online || pending || state.players.length < 3;
  $('fill-bots').classList.toggle('hidden', state.players.length === 3);
  $('fill-bots').disabled = !online || pending;
  $('bid-actions').classList.toggle('hidden', state.phase !== 'bidding');
  for (const button of document.querySelectorAll('[data-bid]')) {
    const value = Number(button.dataset.bid);
    button.disabled = !yourTurn || (value !== 0 && value <= state.bid);
  }
  $('play-actions').classList.toggle('hidden', state.phase !== 'playing');
  $('pass').disabled = !yourTurn || !state.previous;
  $('hint').disabled = !yourTurn;
  $('clear-cards').disabled = !selected.size;
  $('play').disabled = !yourTurn || !beats(classify([...selected]), state.previous?.shape);
  $('leave-room').disabled = !online || pending;
}

function fitHand() {
  const hand = $('hand');
  const count = hand.children.length;
  if (count < 2) return;
  const width = hand.children[0].getBoundingClientRect().width;
  const step = Math.max(26, Math.min(width + 4, (hand.clientWidth - width - 18) / (count - 1)));
  hand.style.setProperty('--overlap', `${step - width}px`);
}

function updateClock() {
  const active = state && ['playing', 'bidding'].includes(state.phase);
  const seconds = active ? Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000)) : 0;
  $('timer').textContent = active ? `${seconds}s` : '';
  $('timer').classList.toggle('urgent', seconds > 0 && seconds <= 5);
}

function playSound(victory) {
  if (!options.sound) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) { toast('Sound effects are not supported by this browser.'); return; }
  audio ??= new Context();
  if (audio.state !== 'running') return;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(victory ? 523 : 330, audio.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(victory ? 1046 : 440, audio.currentTime + 0.1);
  gain.gain.setValueAtTime(0.06, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.22);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + 0.23);
}

$('room-form').addEventListener('submit', (event) => { event.preventDefault(); createRoom(); });
$('join-room').onclick = () => {
  if (!$('player-name').reportValidity()) return;
  store('courtyard-name', $('player-name').value.trim());
  send({ type: 'join', name: $('player-name').value, code: $('room-code').value.trim().toUpperCase() });
};
$('practice').onclick = () => createRoom(true);
$('start-game').onclick = () => command({ type: 'start' });
$('fill-bots').onclick = () => command({ type: 'start', bots: true });
$('play').onclick = () => command({ type: 'play', cards: [...selected] });
$('pass').onclick = () => command({ type: 'pass' });
$('clear-cards').onclick = () => { selected.clear(); render(); };
$('hint').onclick = () => {
  const moves = legalMoves(state.players[state.seat].hand, state.previous?.shape);
  if (!moves.length) { toast('No legal play. You can pass this turn.'); return; }
  selected = new Set(moves[hintIndex++ % moves.length].cards);
  render();
  $('hand').querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: options.reducedMotion ? 'instant' : 'smooth' });
};
for (const button of document.querySelectorAll('[data-bid]')) button.onclick = () => command({ type: 'bid', value: Number(button.dataset.bid) });
$('leave-room').onclick = () => {
  if (['playing', 'bidding'].includes(state.phase) && !confirm('Leave this round? Your seat will use automatic moves.')) return;
  send({ type: 'leave' });
};
$('copy-invite').onclick = async () => {
  const invitation = `${location.origin}/?room=${state.code}`;
  try {
    if (!navigator.clipboard) throw new Error('Clipboard requires HTTPS or localhost.');
    await navigator.clipboard.writeText(invitation);
    toast('Invitation copied. Your friend must be able to reach this server address.');
  } catch (error) {
    console.warn('Could not copy invitation:', error);
    prompt('Copy this invitation. For LAN hosting, replace localhost with the host’s LAN IP:', invitation);
  }
};
$('settings-toggle').onclick = () => {
  const hidden = $('settings').classList.toggle('hidden');
  $('settings-toggle').setAttribute('aria-expanded', !hidden);
};
for (const id of ['rules-open', 'settings-rules']) $(id).onclick = () => $('rules-dialog').showModal();
$('rules-close').onclick = () => $('rules-dialog').close();
$('rules-dialog').addEventListener('click', (event) => { if (event.target === $('rules-dialog')) $('rules-dialog').close(); });
for (const [id, key] of [['reduced-motion', 'reducedMotion'], ['low-power', 'lowPower'], ['sound', 'sound']]) {
  $(id).checked = options[key];
  $(id).onchange = () => {
    options[key] = $(id).checked;
    store(key, String(options[key]));
    document.body.classList.toggle('reduced-motion', options.reducedMotion);
    scene?.configure(options);
    if (key === 'sound' && options.sound) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) {
        audio ??= new Context();
        audio.resume().then(() => playSound(false)).catch((error) => { console.warn('Audio could not start:', error); toast('Sound could not start. Check browser audio permissions.'); });
      } else toast('Sound effects are not supported by this browser.');
    }
  };
}
$('reconnect').onclick = () => { reconnectStarted = 0; reconnectAttempt = 0; connect(); };
window.addEventListener('pointerup', () => { drag = null; });
function unlockAudio() {
  if (!options.sound || audio?.state === 'running') return;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return;
  audio ??= new Context();
  audio.resume().catch((error) => { console.warn('Audio could not resume:', error); toast('Sound is blocked by this browser. Check audio permissions.'); });
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);
window.addEventListener('resize', fitHand);
window.addEventListener('online', () => { reconnectStarted = 0; connect(); });
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('install').classList.remove('hidden');
});
$('install').onclick = async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  $('install').classList.add('hidden');
};
document.body.classList.toggle('reduced-motion', options.reducedMotion);
import('/table.js').then(({ createTable }) => {
  scene = createTable($('scene'), options);
  scene.setGame(Boolean(state));
}).catch((error) => {
  console.error('3D rendering is unavailable:', error);
  document.body.classList.add('visual-fallback');
  $('fatal').textContent = '3D graphics are unavailable on this device. The accessible card table still works.';
  $('fatal').classList.remove('hidden');
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.warn('Installable app setup failed:', error);
    toast('App installation is unavailable. You can still play in this browser.');
  });
}
setInterval(updateClock, 250);
render();
connect();
