const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Client: SelfClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');
const { getSuperProperties } = require('./superprops');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const db = new Database('./clones.db');

db.exec(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, source_guild TEXT, target_guild TEXT, source_name TEXT, target_name TEXT, status TEXT DEFAULT 'idle', logs TEXT DEFAULT '[]')`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 10').all();
  res.json(sessions);
});

function addLog(sessionId, message) {
  console.log(`[${sessionId}] ${message}`);
  const session = db.prepare('SELECT logs FROM sessions WHERE id = ?').get(sessionId);
  const logs = JSON.parse(session?.logs || '[]');
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  db.prepare('UPDATE sessions SET logs = ? WHERE id = ?').run(JSON.stringify(logs.slice(0, 100)), sessionId);
  broadcast({ type: 'log', id: sessionId, message });
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  });
}

app.post('/api/clone', async (req, res) => {
  const { token, sourceGuild, targetGuild } = req.body;
  if (!token || !sourceGuild || !targetGuild) return res.json({ error: 'Missing fields' });
  
  const insert = db.prepare('INSERT INTO sessions (token, source_guild, target_guild, logs) VALUES (?, ?, ?, ?)');
  const result = insert.run(token, sourceGuild, targetGuild, '[]');
  const sessionId = result.lastInsertRowid;
  
  res.json({ success: true, id: sessionId });
  setImmediate(() => runClone(sessionId, token, sourceGuild, targetGuild));
});

async function runClone(sessionId, token, sourceGuild, targetGuild) {
  const selfClient = new SelfClient({ checkUpdate: false });
  selfClient.options.http.api = 'https://discord.com/api/v9';
  selfClient.options.ws.properties = getSuperProperties();
  
  try {
    addLog(sessionId, '🔑 Logging in...');
    await Promise.race([selfClient.login(token), new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 15000))]);
    addLog(sessionId, `✅ Logged in as ${selfClient.user.tag}`);
    
    const source = await selfClient.guilds.fetch(sourceGuild, { force: true });
    const target = await selfClient.guilds.fetch(targetGuild, { force: true });
    addLog(sessionId, `✅ Source: ${source.name} | Target: ${target.name}`);
    
    db.prepare('UPDATE sessions SET source_name = ?, target_name = ?, status = ? WHERE id = ?').run(source.name, target.name, 'deleting', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'deleting' });
    
    await target.channels.fetch({ force: true });
    await target.roles.fetch({ force: true });
    
    for (const [, role] of target.roles.cache.filter(r => r.name !== '@everyone' && r.editable)) {
      try { await role.delete(); addLog(sessionId, `❌ Role: ${role.name}`); await new Promise(r => setTimeout(r, 300)); } catch (e) {}
    }
    
    for (const channel of [...target.channels.cache.values()]) {
      try { await channel.delete(); addLog(sessionId, `❌ Channel: #${channel.name}`); await new Promise(r => setTimeout(r, 300)); } catch (e) {}
    }
    
    await new Promise(r => setTimeout(r, 1000));
    const freshTarget = await selfClient.guilds.fetch(targetGuild, { force: true });
(JSON.stringify(data));
  });
}

app.post('/api/clone', async (req, res) => {
  const { token, sourceGuild, targetGuild } = req.body;
  if (!token || !sourceGuild || !targetGuild) return res.json({ error: 'Missing fields' });
  
  const insert = db.prepare('INSERT INTO sessions (token, source_guild, target_guild, logs) VALUES (?, ?, ?, ?)');
  const result = insert.run(token, sourceGuild, targetGuild, '[]');
  const sessionId = result.lastInsertRowid;
  
  res.json({ success: true, id: sessionId });
  setImmediate(() => runClone(sessionId, token, sourceGuild, targetGuild));
});

async function runClone(sessionId, token, sourceGuild, targetGuild) {
  const selfClient = new SelfClient({ checkUpdate: false });
  selfClient.options.http.api = 'https://discord.com/api/v9';
  selfClient.options.ws.properties = getSuperProperties();
  
  try {
    addLog(sessionId, '🔑 Logging in...');
    await Promise.race([selfClient.login(token), new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 15000))]);
    addLog(sessionId, `✅ Logged in as ${selfClient.user.tag}`);
    
    const source = await selfClient.guilds.fetch(sourceGuild, { force: true });
    const target = await selfClient.guilds.fetch(targetGuild, { force: true });
    addLog(sessionId, `✅ Source: ${source.name} | Target: ${target.name}`);
    
    db.prepare('UPDATE sessions SET source_name = ?, target_name = ?, status = ? WHERE id = ?').run(source.name, target.name, 'deleting', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'deleting' });
    
    await target.channels.fetch({ force: true });
    await target.roles.fetch({ force: true });
    
    for (const [, role] of target.roles.cache.filter(r => r.name !== '@everyone' && r.editable)) {
      try { await role.delete(); addLog(sessionId, `❌ Role: ${role.name}`); await new Promise(r => setTimeout(r, 300)); } catch (e) {}
    }
    
    for (const channel of [...target.channels.cache.values()]) {
      try { await channel.delete(); addLog(sessionId, `❌ Channel: #${channel.name}`); await new Promise(r => setTimeout(r, 300)); } catch (e) {}
    }
    
    await new Promise(r => setTimeout(r, 1000));
    const freshTarget = await selfClient.guilds.fetch(targetGuild, { force: true });
    
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('cloning', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'cloning' });
    
    await freshTarget.setName(source.name);
    if (source.icon) await freshTarget.setIcon(source.iconURL({ dynamic: true }));
    
    const roles = [...source.roles.cache.values()].sort((a, b) => b.position - a.position).filter(r => r.name !== '@everyone');
    for (const role of roles) {
      try { await freshTarget.roles.create({ name: role.name, color: role.color, hoist: role.hoist, permissions: role.permissions.bitfield, mentionable: role.mentionable }); addLog(sessionId, `✅ Role: ${role.name}`); await new Promise(r => setTimeout(r, 400)); } catch (e) {}
    }
    
    await source.channels.fetch({ force: true });
    const channels = [...source.channels.cache.values()].sort((a, b) => a.position - b.position);
    const categoryMap = new Map();
    
    for (const cat of channels.filter(c => c.type === 4)) {
      try { const newCat = await freshTarget.channels.create({ name: cat.name, type: 4, position: cat.position, permissionOverwrites: cat.permissionOverwrites.cache.map(o => ({ id: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) }); categoryMap.set(cat.id, newCat.id); addLog(sessionId, `✅ Category: ${newCat.name}`); await new Promise(r => setTimeout(r, 400)); } catch (e) {}
    }
    
    for (const ch of channels.filter(c => c.type !== 4)) {
      try { const parentId = ch.parentId ? categoryMap.get(ch.parentId) : null; await freshTarget.channels.create({ name: ch.name, type: ch.type, position: ch.position, topic: ch.topic || undefined, nsfw: ch.nsfw || undefined, bitrate: ch.bitrate || undefined, userLimit: ch.userLimit || undefined, parent: parentId, permissionOverwrites: ch.permissionOverwrites.cache.map(o => ({ id: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })) }); addLog(sessionId, `✅ #${ch.name}`); await new Promise(r => setTimeout(r, 400)); } catch (e) {}
    }
    
    selfClient.destroy();
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('completed', sessionId);
    addLog(sessionId, '🎉 Complete!');
    broadcast({ type: 'complete', id: sessionId });
  } catch (err) {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('error', sessionId);
    addLog(sessionId, `💥 Error: ${err.message}`);
    broadcast({ type: 'error', id: sessionId, message: err.message });
    try { selfClient.destroy(); } catch (e) {}
  }
}

server.listen(8080, '0.0.0.0', () => console.log('Server on 8080'));
