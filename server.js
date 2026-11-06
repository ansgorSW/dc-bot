// server.js – Discord-Bot + Web-Dashboard
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client, GatewayIntentBits, PermissionFlagsBits: P, PermissionsBitField,
  ChannelType, OverwriteType,
} = require('discord.js');

// ===== EINSTELLUNGEN (nur das hier ändern) =====
const TOKEN = process.env.DISCORD_TOKEN || '';
const DASH_PASSWORD = process.env.DASH_PASSWORD || 'GHG';
const GUILD_ID = process.env.GUILD_ID || ''; // leer = erster Server des Bots
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
// false = bei "sichtbar" sehen nur die gewählten Rollen (und Admins) den Bereich
// true  = zusätzlich sehen auch Moderatoren alles
const MODS_SEHEN_EINGESCHRAENKTES = false;
// ===============================================

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const PERM = {
  admin: P.Administrator, kick: P.KickMembers, ban: P.BanMembers,
  timeout: P.ModerateMembers, nachrichten: P.ManageMessages,
  kanaele: P.ManageChannels, rollen: P.ManageRoles, log: P.ViewAuditLog,
};
const STAFF = ['admin', 'kick', 'ban', 'timeout', 'nachrichten'];

const uid = () => crypto.randomBytes(5).toString('hex');
const clone = (o) => JSON.parse(JSON.stringify(o));
const sigOf = (ro, view) => JSON.stringify([!!ro, [...view].sort()]);

// ---------- Zustand + Verlauf ----------
let state = { desired: { roles: [], categories: [] }, history: [] };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

function normalize(d) {
  d = d || {};
  const out = { roles: [], categories: [] };
  for (const r of d.roles || []) out.roles.push({
    uid: r.uid || uid(), did: r.did || '', name: String(r.name || 'Rolle'),
    color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toUpperCase() : '#99AAB5',
    perms: (r.perms || []).filter((p) => PERM[p]),
    hoist: r.hoist !== false, mentionable: r.mentionable !== false, del: !!r.del,
  });
  for (const c of d.categories || []) out.categories.push({
    uid: c.uid || uid(), did: c.did || '', name: String(c.name || 'Kategorie'),
    readOnly: !!c.readOnly, view: Array.isArray(c.view) ? c.view : [],
    sig: c.sig || '', del: !!c.del,
    channels: (c.channels || []).map((ch) => ({
      uid: ch.uid || uid(), did: ch.did || '', name: String(ch.name || 'kanal'),
      type: ch.type === 'voice' ? 'voice' : 'text', topic: String(ch.topic || ''),
      slowmode: Math.max(0, parseInt(ch.slowmode) || 0), nsfw: !!ch.nsfw,
      limit: Math.max(0, parseInt(ch.limit) || 0),
      readOnly: ch.readOnly === true ? true : ch.readOnly === false ? false : null,
      view: Array.isArray(ch.view) ? ch.view : [], sig: ch.sig || '', del: !!ch.del,
    })),
  });
  return out;
}
state.desired = normalize(state.desired);

function pushHistory(label) {
  const snap = JSON.stringify(state.desired);
  if (state.history[0] && JSON.stringify(state.history[0].desired) === snap && label === 'Manuelle Änderung') return;
  state.history.unshift({ id: uid(), time: new Date().toISOString(), label, desired: JSON.parse(snap) });
  state.history = state.history.slice(0, 60);
  save();
}

function rollbackTo(snapDesired, label) {
  const cur = state.desired;
  const s = normalize(clone(snapDesired));
  // Dinge, die es jetzt auf dem Server gibt, im Snapshot aber nicht → zum Löschen markieren
  for (const r of cur.roles) if (r.did && !s.roles.some((x) => x.uid === r.uid)) s.roles.push({ ...clone(r), del: true });
  for (const c of cur.categories) {
    const sc = s.categories.find((x) => x.uid === c.uid);
    if (!sc) {
      if (c.did) { const cc = clone(c); cc.del = true; cc.channels.forEach((ch) => (ch.del = true)); s.categories.push(cc); }
    } else {
      for (const ch of c.channels) if (ch.did && !sc.channels.some((x) => x.uid === ch.uid)) sc.channels.push({ ...clone(ch), del: true });
    }
  }
  state.desired = s;
  pushHistory(label);
}

// ---------- Discord-Client (wird bei "Anwenden" neu gestartet) ----------
let client = null;
let busy = false;

function startClient() {
  return new Promise((resolve, reject) => {
    const c = new Client({ intents: [GatewayIntentBits.Guilds] });
    c.once('clientReady', () => resolve(c));
    client = c;
    c.login(TOKEN).catch(reject);
  });
}
async function restartClient() {
  if (client) { try { await client.destroy(); } catch {} client = null; }
  return startClient();
}
function getGuild() {
  if (!client || !client.isReady()) return null;
  return GUILD_ID ? client.guilds.cache.get(GUILD_ID) : client.guilds.cache.first();
}

// ---------- Rechte ----------
function buildOverwrites(guild, d, roleMap, flags, ro, view) {
  const map = new Map();
  const get = (id) => { if (!map.has(id)) map.set(id, { allow: new Set(), deny: new Set() }); return map.get(id); };
  const ev = guild.roles.everyone.id;
  const staffIds = d.roles.filter((r) => !r.del && r.perms.some((p) => STAFF.includes(p)))
    .map((r) => roleMap.get(r.uid)?.id).filter(Boolean);
  if (view.length) {
    get(ev).deny.add(P.ViewChannel);
    for (const u of view) { const id = roleMap.get(u)?.id; if (id) get(id).allow.add(P.ViewChannel); }
    if (MODS_SEHEN_EINGESCHRAENKTES) for (const id of staffIds) get(id).allow.add(P.ViewChannel);
  }
  if (ro) {
    for (const f of flags) get(ev).deny.add(f);
    for (const id of staffIds) for (const f of flags) get(id).allow.add(f);
  }
  return [...map].map(([id, v]) => ({ id, allow: [...v.allow], deny: [...v.deny] }));
}

// ---------- Vom Server laden ----------
function detect(guild, ch, kind) {
  const ev = ch.permissionOverwrites.cache.get(guild.id);
  const flag = kind === 'voice' ? P.Speak : P.SendMessages;
  const ro = !!ev && ev.deny.has(flag);
  const hidden = !!ev && ev.deny.has(P.ViewChannel);
  let view = [];
  if (hidden) {
    view = [...ch.permissionOverwrites.cache.values()]
      .filter((o) => o.type === OverwriteType.Role && o.id !== guild.id && o.allow.has(P.ViewChannel))
      .map((o) => o.id);
  }
  return { ro, view };
}
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function importFromGuild(guild) {
  await guild.roles.fetch(); await guild.channels.fetch();
  const out = { roles: [], categories: [] };
  const roles = [...guild.roles.cache.values()].filter((r) => !r.managed && r.id !== guild.id)
    .sort((a, b) => b.position - a.position);
  for (const r of roles) out.roles.push({
    uid: r.id, did: r.id, name: r.name, color: r.hexColor.toUpperCase(),
    perms: Object.keys(PERM).filter((k) => r.permissions.has(PERM[k], false)),
    hoist: r.hoist, mentionable: r.mentionable,
  });
  const all = [...guild.channels.cache.values()];
  const cats = all.filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => a.rawPosition - b.rawPosition);
  for (const c of cats) {
    const info = detect(guild, c, 'text');
    const cat = { uid: c.id, did: c.id, name: c.name, readOnly: info.ro, view: info.view, channels: [] };
    cat.sig = sigOf(cat.readOnly, cat.view);
    const kids = all.filter((x) => x.parentId === c.id && (x.type === ChannelType.GuildText || x.type === ChannelType.GuildVoice))
      .sort((a, b) => a.rawPosition - b.rawPosition);
    for (const k of kids) {
      const isVoice = k.type === ChannelType.GuildVoice;
      const vi = detect(guild, k, isVoice ? 'voice' : 'text');
      const ch = {
        uid: k.id, did: k.id, name: k.name, type: isVoice ? 'voice' : 'text',
        topic: k.topic || '', slowmode: k.rateLimitPerUser || 0, nsfw: !!k.nsfw,
        limit: k.userLimit || 0,
        readOnly: vi.ro === cat.readOnly ? null : vi.ro,
        view: sameSet(vi.view, cat.view) ? [] : vi.view,
      };
      ch.sig = sigOf(ch.readOnly === null ? cat.readOnly : ch.readOnly, ch.view.length ? ch.view : cat.view);
      cat.channels.push(ch);
    }
    out.categories.push(cat);
  }
  return normalize(out);
}

// ---------- Auf den Server anwenden ----------
async function applyToGuild(guild, L) {
  const d = state.desired;
  await guild.roles.fetch(); await guild.channels.fetch();
  const safe = async (label, fn) => { try { await fn(); } catch (e) { L('❌ ' + label + ': ' + (e.message || e)); } };

  // 1) Löschen (nur was im Dashboard ausdrücklich gelöscht wurde)
  for (const cat of d.categories) {
    for (const ch of cat.channels) if (ch.del && ch.did) await safe('Kanal löschen ' + ch.name, async () => {
      const c = guild.channels.cache.get(ch.did); if (c) { await c.delete('Dashboard'); L('🗑 Kanal gelöscht: ' + ch.name); }
    });
    if (cat.del && cat.did) await safe('Kategorie löschen ' + cat.name, async () => {
      const c = guild.channels.cache.get(cat.did); if (c) { await c.delete('Dashboard'); L('🗑 Kategorie gelöscht: ' + cat.name); }
    });
  }
  for (const r of d.roles) if (r.del && r.did) await safe('Rolle löschen ' + r.name, async () => {
    const x = guild.roles.cache.get(r.did); if (x) { await x.delete('Dashboard'); L('🗑 Rolle gelöscht: ' + r.name); }
  });
  d.roles = d.roles.filter((r) => !r.del);
  d.categories = d.categories.filter((c) => !c.del);
  d.categories.forEach((c) => (c.channels = c.channels.filter((x) => !x.del)));

  const taken = new Set([
    ...d.roles.map((r) => r.did), ...d.categories.map((c) => c.did),
    ...d.categories.flatMap((c) => c.channels.map((x) => x.did)),
  ].filter(Boolean));

  // 2) Rollen
  const roleMap = new Map();
  const managed = Object.values(PERM);
  for (const r of d.roles) await safe('Rolle ' + r.name, async () => {
    let role = r.did ? guild.roles.cache.get(r.did) : null;
    if (!role) role = guild.roles.cache.find((x) => !x.managed && x.id !== guild.id && !taken.has(x.id) && x.name === r.name);
    const sel = r.perms.map((p) => PERM[p]);
    if (!role) {
      const perms = new PermissionsBitField(guild.roles.everyone.permissions.bitfield).add(sel);
      role = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: perms, reason: 'Dashboard' });
      L('➕ Rolle erstellt: ' + r.name);
    } else {
      const want = new PermissionsBitField(role.permissions.bitfield).remove(managed).add(sel);
      const patch = {};
      if (role.name !== r.name) patch.name = r.name;
      if (role.hexColor.toUpperCase() !== r.color) patch.color = r.color;
      if (role.hoist !== r.hoist) patch.hoist = r.hoist;
      if (role.mentionable !== r.mentionable) patch.mentionable = r.mentionable;
      if (role.permissions.bitfield !== want.bitfield) patch.permissions = want;
      if (Object.keys(patch).length) { await role.edit({ ...patch, reason: 'Dashboard' }); L('✏️ Rolle geändert: ' + r.name + ' (' + Object.keys(patch).join(', ') + ')'); }
    }
    taken.add(role.id); r.did = role.id; roleMap.set(r.uid, role);
  });

  // 3) Kategorien
  const catMap = new Map();
  for (const cat of d.categories) await safe('Kategorie ' + cat.name, async () => {
    let c = cat.did ? guild.channels.cache.get(cat.did) : null;
    if (!c) c = guild.channels.cache.find((x) => x.type === ChannelType.GuildCategory && !taken.has(x.id) && x.name === cat.name);
    const sig = sigOf(cat.readOnly, cat.view);
    const ow = buildOverwrites(guild, d, roleMap, [P.SendMessages, P.Speak], cat.readOnly, cat.view);
    if (!c) {
      c = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: ow, reason: 'Dashboard' });
      L('➕ Kategorie erstellt: ' + cat.name);
    } else {
      if (c.name !== cat.name) { await c.setName(cat.name); L('✏️ Kategorie umbenannt: ' + cat.name); }
      if (cat.sig !== sig) { await c.permissionOverwrites.set(ow); L('🔒 Rechte aktualisiert: ' + cat.name); }
    }
    cat.sig = sig; cat.did = c.id; taken.add(c.id); catMap.set(cat.uid, c);
  });

  // 4) Kanäle
  for (const cat of d.categories) {
    const catCh = catMap.get(cat.uid);
    if (!catCh) continue;
    for (const ch of cat.channels) await safe('Kanal ' + ch.name, async () => {
      const isVoice = ch.type === 'voice';
      const type = isVoice ? ChannelType.GuildVoice : ChannelType.GuildText;
      const wantName = isVoice ? ch.name : ch.name.trim().toLowerCase().replace(/\s+/g, '-');
      let c = ch.did ? guild.channels.cache.get(ch.did) : null;
      if (!c) c = guild.channels.cache.find((x) => x.type === type && !taken.has(x.id) && x.parentId === catCh.id &&
        (isVoice ? x.name === wantName : x.name === wantName));
      const ro = ch.readOnly === null ? cat.readOnly : ch.readOnly;
      const view = ch.view.length ? ch.view : cat.view;
      const sig = sigOf(ro, view);
      const ow = buildOverwrites(guild, d, roleMap, [isVoice ? P.Speak : P.SendMessages], ro, view);
      if (!c) {
        const o = { name: wantName, type, parent: catCh.id, permissionOverwrites: ow, reason: 'Dashboard' };
        if (isVoice) o.userLimit = ch.limit;
        else { o.topic = ch.topic || undefined; o.rateLimitPerUser = ch.slowmode; o.nsfw = ch.nsfw; }
        c = await guild.channels.create(o);
        L('➕ Kanal erstellt: ' + ch.name);
      } else {
        const patch = {};
        if (c.name !== wantName) patch.name = wantName;
        if (c.parentId !== catCh.id) patch.parent = catCh.id;
        if (isVoice) { if ((c.userLimit || 0) !== ch.limit) patch.userLimit = ch.limit; }
        else {
          if ((c.topic || '') !== ch.topic) patch.topic = ch.topic;
          if ((c.rateLimitPerUser || 0) !== ch.slowmode) patch.rateLimitPerUser = ch.slowmode;
          if (!!c.nsfw !== ch.nsfw) patch.nsfw = ch.nsfw;
        }
        if (Object.keys(patch).length) { await c.edit({ ...patch, reason: 'Dashboard' }); L('✏️ Kanal geändert: ' + ch.name + ' (' + Object.keys(patch).join(', ') + ')'); }
        if (ch.sig !== sig) { await c.permissionOverwrites.set(ow); L('🔒 Rechte aktualisiert: ' + ch.name); }
      }
      ch.sig = sig; ch.did = c.id; taken.add(c.id);
      if (!isVoice) ch.name = c.name;
    });
  }

  // 5) Reihenfolge
  const pos = [];
  d.categories.forEach((cat, i) => {
    if (!catMap.has(cat.uid)) return;
    pos.push({ channel: cat.did, position: i });
    cat.channels.forEach((ch, j) => { if (ch.did) pos.push({ channel: ch.did, position: j, parent: cat.did }); });
  });
  await safe('Reihenfolge', async () => { await guild.channels.setPositions(pos); L('↕️ Reihenfolge gesetzt'); });

  pushHistory('Auf Server angewendet');
}

// ---------- KI-Syntax ----------
const KNOWN_OPTS = ['name', 'farbe', 'rechte', 'getrennt', 'erwaehnbar', 'erwähnbar', 'thema', 'langsam', 'limit', 'sichtbar', 'position', 'nsfw'];
const KNOWN_FLAGS = ['nurlesen', 'schreibbar', 'nsfw', 'erbe'];

function tokenize(line) {
  const out = [];
  const re = /([A-Za-zÄÖÜäöüß_]+)=("([^"]*)"|\S+)|"([^"]*)"|\S+/g;
  let m;
  while ((m = re.exec(line))) {
    if (m[1]) out.push({ k: m[1].toLowerCase(), v: m[3] !== undefined ? m[3] : m[2] });
    else if (m[4] !== undefined) out.push({ s: m[4] });
    else out.push({ w: m[0] });
  }
  return out;
}
const bool = (v) => ['ja', 'true', '1', 'an', 'yes'].includes(String(v).toLowerCase());
const eq = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const normCh = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '-');
const findRole = (d, n) => d.roles.find((r) => !r.del && eq(r.name, n));
const findCat = (d, n) => d.categories.find((c) => !c.del && eq(c.name, n));
function findChan(d, n, type) {
  const res = [];
  for (const c of d.categories) if (!c.del) for (const ch of c.channels)
    if (!ch.del && (!type || ch.type === type) && normCh(ch.name) === normCh(n)) res.push({ cat: c, ch });
  return res;
}

// Rollennamen dürfen selbst ein "|" enthalten (z. B. "👑 | Admin").
// Mehrere Rollen werden mit "|" getrennt, es wird immer der längste passende Name gesucht.
function resolveRoles(d, str) {
  if (!str || str.toLowerCase() === 'alle') return [];
  const parts = str.split('|');
  const out = [];
  let i = 0;
  while (i < parts.length) {
    let found = null, end = i;
    for (let j = parts.length; j > i; j--) {
      const cand = parts.slice(i, j).join('|').trim();
      const r = findRole(d, cand);
      if (r) { found = r; end = j; break; }
    }
    if (!found) throw new Error('Rolle nicht gefunden: ' + parts.slice(i).join('|'));
    out.push(found.uid);
    i = end;
  }
  return out;
}

function parsePerms(s) {
  if (!s || s.toLowerCase() === 'keine') return [];
  return s.split(/[,|]/).map((x) => x.trim().toLowerCase()).filter(Boolean).map((p) => {
    if (!PERM[p]) throw new Error('Unbekanntes Recht "' + p + '" (erlaubt: ' + Object.keys(PERM).join(', ') + ')');
    return p;
  });
}
function placeAt(arr, item, posStr) {
  if (posStr === undefined) return;
  const p = parseInt(posStr);
  if (!(p >= 1)) throw new Error('position muss eine Zahl ab 1 sein');
  arr.splice(arr.indexOf(item), 1);
  arr.splice(Math.min(p - 1, arr.length), 0, item);
}
function roleOpts(r, o) {
  if (o.name) r.name = o.name;
  if (o.farbe) { const m = /^#?([0-9a-f]{6})$/i.exec(o.farbe); if (!m) throw new Error('Ungültige Farbe: ' + o.farbe); r.color = '#' + m[1].toUpperCase(); }
  if (o.rechte !== undefined) r.perms = parsePerms(o.rechte);
  if (o.getrennt !== undefined) r.hoist = bool(o.getrennt);
  const e = o.erwaehnbar !== undefined ? o.erwaehnbar : o['erwähnbar'];
  if (e !== undefined) r.mentionable = bool(e);
}
function catOpts(d, c, o, f) {
  if (o.name) c.name = o.name;
  if (f.has('nurlesen')) c.readOnly = true;
  if (f.has('schreibbar')) c.readOnly = false;
  if (o.sichtbar !== undefined) c.view = resolveRoles(d, o.sichtbar);
}
function chanOpts(d, ch, o, f) {
  if (o.name) ch.name = o.name;
  if (o.thema !== undefined) { if (ch.type !== 'text') throw new Error('thema gibt es nur bei TEXT'); ch.topic = o.thema; }
  if (o.langsam !== undefined) ch.slowmode = Math.min(21600, Math.max(0, parseInt(o.langsam) || 0));
  if (o.limit !== undefined) ch.limit = Math.min(99, Math.max(0, parseInt(o.limit) || 0));
  if (f.has('nsfw')) ch.nsfw = true;
  if (o.nsfw !== undefined) ch.nsfw = bool(o.nsfw);
  if (f.has('nurlesen')) ch.readOnly = true;
  if (f.has('schreibbar')) ch.readOnly = false;
  if (f.has('erbe')) ch.readOnly = null;
  if (o.sichtbar !== undefined) ch.view = resolveRoles(d, o.sichtbar);
}
function markDeleteCat(d, c) {
  if (c.did) { c.del = true; c.channels.forEach((x) => (x.del = true)); }
  else d.categories.splice(d.categories.indexOf(c), 1);
}

function execLine(d, line) {
  const t = tokenize(line);
  const verbRaw = ((t[0] && t[0].w) || '').toLowerCase();
  if (verbRaw === 'server') return null;
  const verbs = { erstelle: 'create', aendere: 'edit', 'ändere': 'edit', loesche: 'delete', 'lösche': 'delete', verschiebe: 'move' };
  const verb = verbs[verbRaw];
  if (!verb) throw new Error('Unbekannter Befehl "' + verbRaw + '" (erlaubt: ERSTELLE, ÄNDERE, LÖSCHE, VERSCHIEBE)');
  const type = ((t[1] && t[1].w) || '').toLowerCase();
  if (!['rolle', 'kategorie', 'text', 'voice', 'kanal'].includes(type)) throw new Error('Unbekannter Typ "' + type + '" (ROLLE, KATEGORIE, TEXT, VOICE, KANAL)');
  if (!t[2] || t[2].s === undefined) throw new Error('Name fehlt (in Anführungszeichen)');
  const name = t[2].s;
  const flags = new Set(); const o = {}; let parent = null;
  for (let i = 3; i < t.length; i++) {
    const x = t[i];
    if (x.k) { if (!KNOWN_OPTS.includes(x.k)) throw new Error('Unbekannte Option "' + x.k + '"'); o[x.k] = x.v; }
    else if (x.w && x.w.toLowerCase() === 'in' && t[i + 1] && t[i + 1].s !== undefined) { parent = t[i + 1].s; i++; }
    else if (x.w) { const w = x.w.toLowerCase(); if (!KNOWN_FLAGS.includes(w)) throw new Error('Unbekanntes Wort "' + x.w + '"'); flags.add(w); }
    else throw new Error('Unerwarteter Text "' + x.s + '"');
  }

  if (type === 'rolle') {
    if (verb === 'move') throw new Error('VERSCHIEBE gibt es nur für Kanäle/Kategorien');
    if (verb === 'create') {
      if (findRole(d, name)) throw new Error('Rolle existiert schon: ' + name);
      const r = { uid: uid(), did: '', name, color: '#99AAB5', perms: [], hoist: true, mentionable: true };
      roleOpts(r, o); d.roles.push(r); return 'Rolle erstellt: ' + r.name;
    }
    const r = findRole(d, name); if (!r) throw new Error('Rolle nicht gefunden: ' + name);
    if (verb === 'edit') { roleOpts(r, o); return 'Rolle geändert: ' + name; }
    if (r.did) r.del = true; else d.roles.splice(d.roles.indexOf(r), 1);
    return 'Rolle zum Löschen markiert: ' + name;
  }

  if (type === 'kategorie') {
    if (verb === 'create') {
      if (findCat(d, name)) throw new Error('Kategorie existiert schon: ' + name);
      const c = { uid: uid(), did: '', name, readOnly: false, view: [], channels: [], sig: '' };
      catOpts(d, c, o, flags); d.categories.push(c); placeAt(d.categories, c, o.position);
      return 'Kategorie erstellt: ' + c.name;
    }
    const c = findCat(d, name); if (!c) throw new Error('Kategorie nicht gefunden: ' + name);
    if (verb === 'delete') { markDeleteCat(d, c); return 'Kategorie (mit Kanälen) zum Löschen markiert: ' + name; }
    catOpts(d, c, o, flags); placeAt(d.categories, c, o.position);
    return (verb === 'move' ? 'Kategorie verschoben: ' : 'Kategorie geändert: ') + name;
  }

  // Kanäle
  const ctype = type === 'voice' ? 'voice' : type === 'text' ? 'text' : null;
  if (verb === 'create') {
    if (!ctype) throw new Error('Bei ERSTELLE bitte TEXT oder VOICE benutzen');
    if (!parent) throw new Error('in "Kategorie" fehlt');
    const cat = findCat(d, parent); if (!cat) throw new Error('Kategorie nicht gefunden: ' + parent);
    if (cat.channels.some((x) => !x.del && x.type === ctype && normCh(x.name) === normCh(name))) throw new Error('Kanal existiert schon: ' + name);
    const ch = { uid: uid(), did: '', name, type: ctype, topic: '', slowmode: 0, nsfw: false, limit: 0, readOnly: null, view: [], sig: '' };
    chanOpts(d, ch, o, flags); cat.channels.push(ch); placeAt(cat.channels, ch, o.position);
    return 'Kanal erstellt: ' + ch.name;
  }
  let m = findChan(d, name, ctype);
  if (verb !== 'move' && parent) m = m.filter((x) => eq(x.cat.name, parent));
  if (!m.length) throw new Error('Kanal nicht gefunden: ' + name);
  if (m.length > 1) throw new Error('Kanalname mehrdeutig, bitte in "Kategorie" angeben: ' + name);
  const { cat, ch } = m[0];
  if (verb === 'delete') { if (ch.did) ch.del = true; else cat.channels.splice(cat.channels.indexOf(ch), 1); return 'Kanal zum Löschen markiert: ' + name; }
  if (verb === 'move') {
    if (!parent) throw new Error('Ziel fehlt: in "Kategorie"');
    const target = findCat(d, parent); if (!target) throw new Error('Kategorie nicht gefunden: ' + parent);
    cat.channels.splice(cat.channels.indexOf(ch), 1); target.channels.push(ch);
    placeAt(target.channels, ch, o.position);
    return 'Kanal verschoben: ' + name + ' → ' + target.name;
  }
  chanOpts(d, ch, o, flags); placeAt(cat.channels, ch, o.position);
  return 'Kanal geändert: ' + name;
}

function runCommands(d, text) {
  const log = [], errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith('```')) return;
    try { const m = execLine(d, line); if (m) log.push(m); }
    catch (e) { errors.push('Zeile ' + (i + 1) + ': ' + e.message + '   →   ' + line); }
  });
  return { log, errors };
}

function dump(d) {
  const q = (s) => String(s).replace(/"/g, "'");
  const names = (uids) => uids.map((u) => (d.roles.find((r) => r.uid === u) || {}).name).filter(Boolean).map(q).join('|');
  const L = ['# AKTUELLER STAND DES SERVERS (alles existiert schon – zum Ändern ÄNDERE / LÖSCHE / VERSCHIEBE benutzen)', ''];
  for (const r of d.roles.filter((x) => !x.del))
    L.push('ROLLE "' + q(r.name) + '" farbe=' + r.color + ' rechte=' + (r.perms.join(',') || 'keine') + ' getrennt=' + (r.hoist ? 'ja' : 'nein') + ' erwaehnbar=' + (r.mentionable ? 'ja' : 'nein'));
  L.push('');
  for (const c of d.categories.filter((x) => !x.del)) {
    L.push('KATEGORIE "' + q(c.name) + '"' + (c.readOnly ? ' nurlesen' : '') + (c.view.length ? ' sichtbar="' + names(c.view) + '"' : ''));
    for (const ch of c.channels.filter((x) => !x.del)) {
      L.push('  ' + (ch.type === 'voice' ? 'VOICE' : 'TEXT') + ' "' + q(ch.name) + '"' +
        (ch.topic ? ' thema="' + q(ch.topic) + '"' : '') + (ch.slowmode ? ' langsam=' + ch.slowmode : '') +
        (ch.nsfw ? ' nsfw' : '') + (ch.type === 'voice' && ch.limit ? ' limit=' + ch.limit : '') +
        (ch.readOnly === true ? ' nurlesen' : ch.readOnly === false ? ' schreibbar' : '') +
        (ch.view.length ? ' sichtbar="' + names(ch.view) + '"' : ''));
    }
    L.push('');
  }
  return L.join('\n');
}

const AI_PROMPT = [
  'Du hilfst mir, meinen Discord-Server zu verwalten. Antworte NUR mit Befehlen in der folgenden Syntax: ein Befehl pro Zeile, alles in EINEM Code-Block, keine Erklärungen im Code-Block. Mein Dashboard liest die Befehle und ändert die Serverstruktur. Vorhandene Rollen und Kanäle werden bearbeitet, nicht gelöscht und neu erstellt.',
  '',
  'BEFEHLE:',
  'ERSTELLE ROLLE "Name" farbe=#RRGGBB rechte=admin,kick,ban,timeout,nachrichten,kanaele,rollen,log getrennt=ja erwaehnbar=ja',
  'ERSTELLE KATEGORIE "Name" [nurlesen] [sichtbar="Rolle1|Rolle2"] [position=3]',
  'ERSTELLE TEXT "kanalname" in "Kategorie" [thema="..."] [langsam=10] [nsfw] [nurlesen|schreibbar] [sichtbar="Rolle1|Rolle2"] [position=1]',
  'ERSTELLE VOICE "Name" in "Kategorie" [limit=5] [nurlesen|schreibbar] [sichtbar="..."] [position=1]',
  'ÄNDERE ROLLE|KATEGORIE|TEXT|VOICE|KANAL "aktueller Name" name="neuer Name" plus beliebige Optionen von oben',
  'VERSCHIEBE TEXT|VOICE|KANAL "Name" in "Ziel-Kategorie" [position=2]',
  'LÖSCHE ROLLE|KATEGORIE|TEXT|VOICE|KANAL "Name"',
  '',
  'REGELN:',
  '- Namen immer in "Anführungszeichen", Emojis sind erlaubt. Zeilen mit # sind Kommentare.',
  '- Beim Ändern immer den AKTUELLEN Namen angeben, den neuen mit name="..." setzen. Bei ÄNDERE/LÖSCHE kann in "Kategorie" helfen, wenn ein Name doppelt vorkommt.',
  '- Text-Kanalnamen sind klein geschrieben, Leerzeichen werden zu Bindestrichen.',
  '- Der Kanaltyp (TEXT/VOICE) kann nach dem Erstellen nicht geändert werden.',
  '- nurlesen = nur Rollen mit Moderator-/Admin-Rechten dürfen schreiben, schreibbar hebt das auf. sichtbar="A|B" = nur diese Rollen sehen es, sichtbar=alle hebt das auf.',
  '- Löschen nur, wenn ich es ausdrücklich verlange.',
  '',
  'BEISPIEL:',
  'ERSTELLE ROLLE "🌟 | VIP" farbe=#FFD700 rechte=keine',
  'ERSTELLE KATEGORIE "🎲 | SPIELE" position=3',
  'ERSTELLE TEXT "🎲︱würfeln" in "🎲 | SPIELE" thema="Hier wird gewürfelt"',
  'ÄNDERE TEXT "🤖︱bot-spam" name="🤖︱bots" langsam=5',
  'VERSCHIEBE VOICE "🔊︱Talk 2" in "🎲 | SPIELE"',
  '',
  'Wenn ich dir den AKTUELLEN STAND gebe, beschreibt er, was schon existiert.',
].join('\n');

// ---------- Web-Server ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/api', (req, res, next) => {
  if (req.get('x-pass') !== DASH_PASSWORD) return res.status(401).json({ error: 'Falsches Passwort' });
  next();
});

function publicState() {
  const g = getGuild();
  return {
    desired: state.desired,
    history: state.history.map((h) => ({ id: h.id, time: h.time, label: h.label })),
    bot: { online: !!(client && client.isReady()), guild: g ? g.name : '' },
  };
}

app.get('/api/state', (req, res) => res.json(publicState()));

app.post('/api/state', (req, res) => {
  state.desired = normalize(req.body.desired);
  pushHistory(req.body.label || 'Manuelle Änderung');
  res.json(publicState());
});

app.post('/api/import', async (req, res) => {
  try {
    const g = getGuild(); if (!g) throw new Error('Bot ist offline oder auf keinem Server.');
    state.desired = await importFromGuild(g);
    pushHistory('Vom Server geladen');
    res.json(publicState());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apply', async (req, res) => {
  if (busy) return res.status(409).json({ error: 'Es läuft schon ein Vorgang.' });
  busy = true; const log = [];
  try {
    log.push('🔄 Bot wird neu gestartet …');
    await restartClient();
    log.push('✅ Bot ist wieder online.');
    const g = getGuild(); if (!g) throw new Error('Der Bot ist auf keinem Server.');
    await applyToGuild(g, (m) => log.push(m));
    log.push('🏁 Fertig.');
    res.json({ ok: true, log, state: publicState() });
  } catch (e) { res.status(500).json({ error: e.message || String(e), log }); }
  finally { busy = false; }
});

app.post('/api/rollback', (req, res) => {
  const h = state.history.find((x) => x.id === req.body.id);
  if (!h) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  rollbackTo(h.desired, 'Zurückgerollt auf: ' + h.label);
  res.json(publicState());
});

app.post('/api/undo', (req, res) => {
  const prev = state.history[1];
  if (!prev) return res.status(400).json({ error: 'Nichts zum Rückgängigmachen' });
  rollbackTo(prev.desired, 'Rückgängig');
  res.json(publicState());
});

app.get('/api/ai/prompt', (req, res) => res.json({ text: AI_PROMPT }));
app.get('/api/ai/dump', (req, res) => res.json({ text: dump(state.desired) }));
app.post('/api/ai/preview', (req, res) => {
  res.json(runCommands(clone(state.desired), String(req.body.text || '')));
});
app.post('/api/ai/commit', (req, res) => {
  const d = clone(state.desired);
  const r = runCommands(d, String(req.body.text || ''));
  if (r.errors.length) return res.status(400).json({ ...r, error: 'Es gibt Fehler – nichts wurde übernommen.' });
  state.desired = normalize(d);
  pushHistory('KI-Änderung (' + r.log.length + ' Befehle)');
  res.json({ ...r, state: publicState() });
});

process.on('unhandledRejection', (e) => console.error('Fehler:', e));
app.listen(PORT, '0.0.0.0', () => console.log('Dashboard läuft auf Port ' + PORT));
startClient()
  .then(() => console.log('Bot online: ' + client.user.tag))
  .catch((e) => console.error('Bot-Login fehlgeschlagen (Token prüfen):', e.message));