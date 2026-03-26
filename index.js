const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Client: SelfClient } = require('discord.js-selfbot-v13');
const Database = require('better-sqlite3');
const { getSuperProperties } = require('./superprops');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new Database('./clones.db');
db.exec(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT, source_guild TEXT, target_guild TEXT, source_name TEXT, target_name TEXT, status TEXT DEFAULT 'idle')`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 10').all();
  res.json(sessions);
});

app.post('/api/clone', async (req, res) => {
  const { token, sourceGuild, targetGuild } = req.body;
  
  if (!token || !sourceGuild || !targetGuild) {
    return res.json({ error: 'Missing fields' });
  }
  
  const insert = db.prepare('INSERT INTO sessions (token, source_guild, target_guild) VALUES (?, ?, ?)');
  const result = insert.run(token, sourceGuild, targetGuild);
  const sessionId = result.lastInsertRowid;
  
  broadcast({ type: 'cloneStart', id: sessionId });
  
  const selfClient = new SelfClient({ checkUpdate: false });
  selfClient.options.http.api = 'https://discord.com/api/v9';
  selfClient.options.ws.properties = getSuperProperties();
  
  try {
    await selfClient.login(token);
    
    const source = await selfClient.guilds.fetch(sourceGuild);
    const target = await selfClient.guilds.fetch(targetGuild);
    
    db.prepare('UPDATE sessions SET source_name = ?, target_name = ?, status = ? WHERE id = ?')
      .run(source.name, target.name, 'deleting', sessionId);
    
    broadcast({ type: 'progress', id: sessionId, step: 'Deleting old content...' });
    
    const existingRoles = target.roles.cache.filter(r => r.name !== '@everyone' && r.editable);
    for (const [, role] of existingRoles) {
      try { await role.delete(); await new Promise(r => setTimeout(r, 200)); } catch (e) {}
    }
    
    const existingChannels = [...target.channels.cache.values()];
    for (const channel of existingChannels) {
      try { await channel.delete(); await new Promise(r => setTimeout(r, 200)); } catch (e) {}
    }
    
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('cloning', sessionId);
    broadcast({ type: 'progress', id: sessionId, step: 'Cloning server...' });
    
    await target.setName(source.name);
    if (source.icon) await target.setIcon(source.iconURL({ dynamic: true }));
    
    const roles = [...source.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .filter(r => r.name !== '@everyone');
    
    for (const role of roles) {
      try {
        await target.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          permissions: role.permissions.bitfield,
          mentionable: role.mentionable
        });
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {}
    }
    
    const channels = [...source.channels.cache.values()].sort((a, b) => a.position - b.position);
    const categoryMap = new Map();
    
    for (const channel of channels) {
      if (channel.type === 4) {
        try {
          const newCat = await target.channels.create({
            name: channel.name,
            type: channel.type,
            position: channel.position,
            permissionOverwrites: channel.permissionOverwrites.cache.map(o => ({
              id: o.id,
              allow: o.allow.bitfield,
              deny: o.deny.bitfield
            }))
          });
          categoryMap.set(channel.id, newCat.id);
          await new Promise(r => setTimeout(r, 350));
        } catch (e) {}
      }
    }
    
    for (const channel of channels) {
      if (channel.type !== 4) {
        try {
          await target.channels.create({
            name: channel.name,
            type: channel.type,
            parent: channel.parentId ? categoryMap.get(channel.parentId) : null,
            position: channel.position,
            topic: channel.topic || undefined,
            nsfw: channel.nsfw,
            bitrate: channel.bitrate,
            userLimit: channel.userLimit,
            permissionOverwrites: channel.permissionOverwrites.cache.map(o => ({
              id: o.id,
              allow: o.allow.bitfield,
              deny: o.deny.bitfield
            }))
          });
          await new Promise(r => setTimeout(r, 350));
        } catch (e) {}
      }
    }
    
    selfClient.destroy();
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('completed', sessionId);
    broadcast({ type: 'complete', id: sessionId, message: 'Clone complete!' });
    
    res.json({ success: true, id: sessionId });
  } catch (err) {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('error', sessionId);
    broadcast({ type: 'error', id: sessionId, message: err.message });
    res.json({ error: err.message });
  }
});

const clients = new Set();

function broadcast(data) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
