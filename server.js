// Servidor de "Valle del Musgo"
// Node.js puro: sin dependencias, no hace falta npm install.
// - Cuentas con correo y contraseña (guardadas cifradas con scrypt en data/db.cuentas.json)
// - Salas públicas y privadas con código
// - Multijugador en tiempo real por WebSocket (implementado acá mismo, sin librerías)
// - Sirve el juego desde la carpeta public/

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const VERSION = '1.0.0';
const VILLAGE_R = 22;          // radio del pueblo (zona segura, sin PvP)
const MAX_PER_ROOM = 20;
const TICK_MS = 100;           // 10 actualizaciones por segundo
const SESSION_DAYS = 30;

// ---------- Guardado ----------
// Sin DATABASE_URL: archivos JSON en data/ (para probar en tu PC).
// Con DATABASE_URL (Neon, Postgres gratis): todo queda guardado aunque Render reinicie.
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = { cuentas: {}, sesiones: {}, salas: {}, cofres: {} };
let pool = null;
const pendingWrites = new Map();
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch (_) { return fallback; }
}
function writeFileSoon(tipo) {
  clearTimeout(pendingWrites.get(tipo));
  pendingWrites.set(tipo, setTimeout(() => {
    const file = path.join(DATA_DIR, tipo + '.json'), tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db[tipo], null, 2), err => {
      if (err) return console.error('No se pudo guardar', tipo, err.message);
      fs.rename(tmp, file, e => { if (e) console.error('No se pudo guardar', tipo, e.message); });
    });
  }, 300));
}
// guarda (o borra) una sola entrada
function put(tipo, clave) {
  if (!pool) return writeFileSoon(tipo);
  const k = tipo + '\u0000' + clave;
  clearTimeout(pendingWrites.get(k));
  pendingWrites.set(k, setTimeout(async () => {
    pendingWrites.delete(k);
    const valor = db[tipo][clave];
    try {
      if (valor === undefined) await pool.query('DELETE FROM datos WHERE tipo=$1 AND clave=$2', [tipo, clave]);
      else await pool.query('INSERT INTO datos (tipo, clave, valor) VALUES ($1,$2,$3) ON CONFLICT (tipo, clave) DO UPDATE SET valor=EXCLUDED.valor', [tipo, clave, JSON.stringify(valor)]);
    } catch (e) { console.error('No se pudo guardar en la base de datos', tipo, e.message); }
  }, 250));
}
async function initStore() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
    await pool.query('CREATE TABLE IF NOT EXISTS datos (tipo text NOT NULL, clave text NOT NULL, valor jsonb NOT NULL, PRIMARY KEY (tipo, clave))');
    const r = await pool.query('SELECT tipo, clave, valor FROM datos');
    for (const row of r.rows) if (db[row.tipo]) db[row.tipo][row.clave] = row.valor;
    console.log(' Base de datos conectada: ' + r.rows.length + ' registros');
  } else {
    for (const t of Object.keys(db)) db[t] = readJSON(t + '.json', {});
    console.log(' Guardando en archivos JSON (carpeta data/)');
  }
  if (!db.salas.PUBLICA) { db.salas.PUBLICA = { publica: true, seed: 1 + Math.floor(Math.random() * 99999), creada: Date.now() }; put('salas', 'PUBLICA'); }
}

// ---------- Utilidades ----------
const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }
function samePass(pass, salt, hash) {
  const a = Buffer.from(hashPass(pass, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomCode() { let c; do { c = ''; for (let i = 0; i < 6; i++) c += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]; } while (db.salas[c]); return c; }
// mismo cálculo que el juego, así el código siempre da el mismo mapa
function seedFromCode(code) { let h = 2166136261; for (const ch of code) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 99999 + 1; }
function clean(s, max) { return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max); }

function newSession(email) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sesiones[token] = { email, vence: Date.now() + SESSION_DAYS * 864e5 };
  put('sesiones', token);
  return token;
}
function userFromToken(token) {
  const s = token && db.sesiones[token];
  if (!s) return null;
  if (s.vence < Date.now()) { delete db.sesiones[token]; put('sesiones', token); return null; }
  const c = db.cuentas[s.email];
  return c ? { email: s.email, ...c } : null;
}
const perfil = (email, c, token) => ({ email, nombre: c.nombre, salas: c.salas || [], token });

// límite de intentos de inicio de sesión por IP
const intentos = new Map();
function tooMany(ip) {
  const now = Date.now(), l = (intentos.get(ip) || []).filter(t => now - t < 5 * 60e3);
  l.push(now); intentos.set(ip, l);
  return l.length > 15;
}

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (url.pathname.startsWith('/api/')) {
    try {
      if (req.method === 'GET' && url.pathname === '/api/estado') {
        return send(res, 200, { ok: true, version: VERSION, jugadores: clients.size });
      }
      if (req.method === 'POST' && url.pathname === '/api/registro') {
        if (tooMany(ip)) return send(res, 429, { error: 'Demasiados intentos. Esperá unos minutos.' });
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase(), pass = String(b.password || ''), nombre = clean(b.nombre, 14);
        if (!validEmail(email)) return send(res, 400, { error: 'Escribí un correo válido.' });
        if (pass.length < 6 || pass.length > 100) return send(res, 400, { error: 'La contraseña tiene que tener entre 6 y 100 caracteres.' });
        if (nombre.length < 2) return send(res, 400, { error: 'Tu nombre de jugador tiene que tener al menos 2 letras.' });
        if (db.cuentas[email]) return send(res, 409, { error: 'Ya existe una cuenta con ese correo. Iniciá sesión.' });
        if (Object.values(db.cuentas).some(c => c.nombre.toLowerCase() === nombre.toLowerCase())) return send(res, 409, { error: 'Ese nombre de jugador ya está en uso.' });
        const salt = crypto.randomBytes(16).toString('hex');
        db.cuentas[email] = { nombre, salt, hash: hashPass(pass, salt), creada: Date.now(), salas: [] };
        put('cuentas', email);
        console.log('Cuenta nueva:', nombre);
        return send(res, 200, perfil(email, db.cuentas[email], newSession(email)));
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (tooMany(ip)) return send(res, 429, { error: 'Demasiados intentos. Esperá unos minutos.' });
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase(), pass = String(b.password || '');
        const c = db.cuentas[email];
        if (!c || !samePass(pass, c.salt, c.hash)) return send(res, 401, { error: 'El correo o la contraseña no son correctos.' });
        return send(res, 200, perfil(email, c, newSession(email)));
      }
      if (req.method === 'GET' && url.pathname === '/api/yo') {
        const u = userFromToken(token);
        if (!u) return send(res, 401, { error: 'Tu sesión venció. Volvé a entrar.' });
        return send(res, 200, perfil(u.email, u, token));
      }
      if (req.method === 'POST' && url.pathname === '/api/salir') {
        if (db.sesiones[token]) { delete db.sesiones[token]; put('sesiones', token); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/salas') {
        const u = userFromToken(token);
        if (!u) return send(res, 401, { error: 'Tu sesión venció. Volvé a entrar.' });
        const codigo = newRoomCode();
        db.salas[codigo] = { duenio: u.email, seed: seedFromCode(codigo), creada: Date.now() };
        put('salas', codigo);
        rememberRoom(u.email, codigo);
        return send(res, 200, { codigo, seed: db.salas[codigo].seed, jugadores: 0 });
      }
      if (url.pathname === '/api/cofre') {
        const u = userFromToken(token);
        if (!u) return send(res, 401, { error: 'Tu sesión venció. Volvé a entrar.' });
        if (req.method === 'GET') return send(res, 200, { cofre: db.cofres[u.email] || null });
        if (req.method === 'PUT') {
          const b = await readBody(req), c = b.cofre || {};
          const n = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
          const items = Array.isArray(c.items) ? c.items.filter(x => typeof x === 'string' && /^[a-z]{2,8}$/.test(x)).slice(0, 60) : [];
          db.cofres[u.email] = { wood: n(c.wood, 1e6), stone: n(c.stone, 1e6), ore: n(c.ore, 1e6), weapon: n(c.weapon, 3), armor: n(c.armor, 3), items, guardado: Date.now() };
          put('cofres', u.email);
          return send(res, 200, { ok: true });
        }
      }
      const m = url.pathname.match(/^\/api\/salas\/([A-Z0-9]{6,7})$/);
      if (req.method === 'GET' && m) {
        const u = userFromToken(token);
        if (!u) return send(res, 401, { error: 'Tu sesión venció. Volvé a entrar.' });
        const s = db.salas[m[1]];
        if (!s) return send(res, 404, { error: 'No existe ninguna sala con ese código.' });
        if (!s.publica) rememberRoom(u.email, m[1]);
        return send(res, 200, { codigo: m[1], seed: s.seed, jugadores: (rooms.get(m[1]) || new Map()).size });
      }
      return send(res, 404, { error: 'No existe.' });
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: 'Error del servidor.' });
    }
  }

  // archivos del juego
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' || url.pathname === '') file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
function rememberRoom(email, code) {
  const c = db.cuentas[email]; if (!c) return;
  c.salas = [code, ...(c.salas || []).filter(x => x !== code)].slice(0, 5);
  put('cuentas', email);
}

// ---------- WebSocket (sin librerías) ----------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(str, opcode = 1) {
  const payload = Buffer.from(str), len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}
function wsSend(cl, obj) { if (cl.open) { try { cl.socket.write(wsFrame(JSON.stringify(obj))); } catch (_) {} } }
function wsParse(cl, chunk) {
  cl.buf = Buffer.concat([cl.buf, chunk]);
  while (cl.buf.length >= 2) {
    const b0 = cl.buf[0], b1 = cl.buf[1], opcode = b0 & 0x0f, masked = b1 & 0x80;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (cl.buf.length < 4) return; len = cl.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (cl.buf.length < 10) return; len = Number(cl.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 65536 || !masked) return closeClient(cl, 'mensaje inválido');
    if (cl.buf.length < off + 4 + len) return;
    const mask = cl.buf.slice(off, off + 4), data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = cl.buf[off + 4 + i] ^ mask[i & 3];
    cl.buf = cl.buf.slice(off + 4 + len);
    cl.last = Date.now();
    if (opcode === 0x8) return closeClient(cl);
    if (opcode === 0x9) { try { cl.socket.write(wsFrame(data.toString(), 0xA)); } catch (_) {} continue; }
    if (opcode === 0x1) { let msg; try { msg = JSON.parse(data.toString()); } catch (_) { continue; } onMessage(cl, msg); }
  }
}

// ---------- Salas en vivo ----------
const rooms = new Map();   // codigo -> Map(id -> cliente)
const clients = new Set();
let nextId = 1;
const inVillage = (x, z) => x < 250 && x * x + z * z < VILLAGE_R * VILLAGE_R;
function broadcast(room, obj, except) { for (const cl of (rooms.get(room) || new Map()).values()) if (cl !== except) wsSend(cl, obj); }

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const reject = (code, msg) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); };
  if (url.pathname !== '/juego' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return reject(400, 'Bad Request');
  const user = userFromToken(url.searchParams.get('token'));
  if (!user) return reject(401, 'Unauthorized');
  const code = (url.searchParams.get('sala') || '').toUpperCase();
  if (!db.salas[code]) return reject(404, 'Not Found');
  const room = rooms.get(code) || new Map();
  if (room.size >= MAX_PER_ROOM) return reject(403, 'Forbidden');
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  // si la misma cuenta ya estaba conectada, se cierra la sesión anterior
  for (const old of clients) if (old.email === user.email) closeClient(old, 'entraste desde otro lugar');

  const cl = { id: nextId++, socket, email: user.email, nombre: user.nombre, room: code, buf: Buffer.alloc(0), open: true, last: Date.now(), st: null };
  clients.add(cl); room.set(cl.id, cl); rooms.set(code, room);
  console.log(`${cl.nombre} entró a la sala ${code} (${room.size} jugadores)`);
  wsSend(cl, { t: 'hola', id: cl.id, sala: code, seed: db.salas[code].seed });
  broadcast(code, { t: 'entra', id: cl.id, nombre: cl.nombre }, cl);
  socket.on('data', c => wsParse(cl, c));
  socket.on('close', () => closeClient(cl));
  socket.on('error', () => closeClient(cl));
});
function closeClient(cl, why) {
  if (!cl.open) return;
  cl.open = false;
  if (why) { try { cl.socket.write(wsFrame(JSON.stringify({ t: 'aviso', txt: 'Desconectado: ' + why }))); } catch (_) {} }
  try { cl.socket.end(wsFrame('', 0x8)); } catch (_) {}
  clients.delete(cl);
  const room = rooms.get(cl.room);
  if (room) { room.delete(cl.id); if (!room.size) rooms.delete(cl.room); }
  broadcast(cl.room, { t: 'sale', id: cl.id, nombre: cl.nombre });
  console.log(`${cl.nombre} salió de la sala ${cl.room}`);
}
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
function onMessage(cl, m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'estado') {
    const clan = m.k && typeof m.k === 'object' ? { tag: clean(m.k.tag, 4), color: /^#[0-9a-f]{6}$/i.test(m.k.color) ? m.k.color : '#ebe6cf', logo: clean(m.k.logo, 10) } : null;
    cl.st = { x: num(m.x, -500, 700), z: num(m.z, -500, 700), y: num(m.y, -2, 10), r: num(m.r, -100, 100), c: clean(m.c, 10), a: clean(m.a, 8), h: num(m.h, 0, 5000), m: num(m.m, 1, 5000), v: !!m.v, o: !!m.o, k: clan };
  } else if (m.t === 'disparo') {
    broadcast(cl.room, { t: 'disparo', id: cl.id, x: num(m.x, -500, 700), z: num(m.z, -500, 700), dx: num(m.dx, -1, 1), dz: num(m.dz, -1, 1), tipo: clean(m.tipo, 10) }, cl);
  } else if (m.t === 'golpe') {
    const room = rooms.get(cl.room), target = room && room.get(Number(m.a));
    if (!target || !target.st || !cl.st || target === cl) return;
    if (inVillage(cl.st.x, cl.st.z) || inVillage(target.st.x, target.st.z)) return;   // sin PvP en el pueblo
    if (Math.hypot(cl.st.x - target.st.x, cl.st.z - target.st.z) > 40) return;
    wsSend(target, { t: 'golpe', de: cl.id, nombre: cl.nombre, dmg: Math.round(num(m.dmg, 0, 600)) });
  } else if (m.t === 'muerte') {
    const room = rooms.get(cl.room), by = room && room.get(Number(m.por));
    broadcast(cl.room, { t: 'baja', victima: cl.nombre, asesino: by ? by.nombre : null });
  } else if (m.t === 'chat') {
    const txt = clean(m.txt, 140);
    if (!txt) return;
    const now = Date.now();
    if (cl.lastChat && now - cl.lastChat < 700) return;
    cl.lastChat = now;
    broadcast(cl.room, { t: 'chat', id: cl.id, nombre: cl.nombre, txt });
  }
}
// 10 veces por segundo se manda a cada sala dónde está cada jugador
setInterval(() => {
  for (const [code, room] of rooms) {
    const l = [];
    for (const cl of room.values()) if (cl.st) l.push({ id: cl.id, n: cl.nombre, ...cl.st });
    if (l.length) { const msg = wsFrame(JSON.stringify({ t: 'estados', l })); for (const cl of room.values()) if (cl.open) { try { cl.socket.write(msg); } catch (_) {} } }
  }
}, TICK_MS);
// conexiones colgadas
setInterval(() => {
  const now = Date.now();
  for (const cl of clients) {
    if (now - cl.last > 45e3) closeClient(cl, 'sin respuesta');
    else try { cl.socket.write(wsFrame('', 0x9)); } catch (_) {}
  }
}, 20e3);

initStore().then(() => server.listen(PORT, () => {
  console.log('-----------------------------------------');
  console.log(' Valle del Musgo · servidor encendido');
  console.log(' Abrí en el navegador: http://localhost:' + PORT);
  console.log(' Cuentas registradas: ' + Object.keys(db.cuentas).length);
  console.log('-----------------------------------------');
})).catch(e => { console.error('No se pudo iniciar el guardado:', e.message); process.exit(1); });
