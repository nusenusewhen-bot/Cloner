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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 10').all();
  res.json(sessions);
});

function addLog(sessionId, message) {
  const session = db.prepare('SELECT logs FROM sessions WHERE id = ?').get(sessionId);
  const logs = JSON.parse(session.logs || '[]');
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  db.prepare('UPDATE sessions SET logs = ? WHERE id = ?').run(JSON.stringify(logs.slice(0, 100)), sessionId);
  broadcast({ type: 'log', id: sessionId, message });
  return logs;
}

app.post('/api/clone', async (req, res) => {
  const { token, sourceGuild, targetGuild } = req.body;
  
  if (!token || !sourceGuild || !targetGuild) {
    return res.json({ error: 'Missing fields' });
  }
  
  const insert = db.prepare('INSERT INTO sessions (token, source_guild, target_guild, logs) VALUES (?, ?, ?, ?)');
  const result = insert.run(token, sourceGuild, targetGuild, '[]');
  const sessionId = result.lastInsertRowid;
  
  res.json({ success: true, id: sessionId });
  
  const selfClient = new SelfClient({ checkUpdate: false });
  selfClient.options.http.api = 'https://discord.com/api/v9';
  selfClient.options.ws.properties = getSuperProperties();
  
  try {
    addLog(sessionId, '🔑 Logging in with token...');
    await selfClient.login(token);
    addLog(sessionId, `✅ Logged in as ${selfClient.user.tag}`);
    
    addLog(sessionId, '📡 Fetching source guild...');
    const source = await selfClient.guilds.fetch(sourceGuild);
    addLog(sessionId, `✅ Source: ${source.name} (${source.id})`);
    
    addLog(sessionId, '📡 Fetching target guild...');
    const target = await selfClient.guilds.fetch(targetGuild);
    addLog(sessionId, `✅ Target: ${target.name} (${target.id})`);
    
    db.prepare('UPDATE sessions SET source_name = ?, target_name = ?, status = ? WHERE id = ?')
      .run(source.name, target.name, 'deleting', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'deleting' });
    
    const existingRoles = target.roles.cache.filter(r => r.name !== '@everyone' && r.editable);
    addLog(sessionId, `🗑️ Deleting ${existingRoles.size} roles...`);
    
    for (const [, role] of existingRoles) {
      try { 
        await role.delete(); 
        addLog(sessionId, `❌ Role deleted: ${role.name}`);
        await new Promise(r => setTimeout(r, 200)); 
      } catch (e) {
        addLog(sessionId, `⚠️ Failed to delete role ${role.name}: ${e.message}`);
      }
    }
    
    const existingChannels = [...target.channels.cache.values()];
    addLog(sessionId, `🗑️ Deleting ${existingChannels.length} channels...`);
    
    for (const channel of existingChannels) {
      try { 
        await channel.delete(); 
        addLog(sessionId, `❌ Channel deleted: #${channel.name}`);
        await new Promise(r => setTimeout(r, 200)); 
      } catch (e) {
        addLog(sessionId, `⚠️ Failed to delete channel #${channel.name}: ${e.message}`);
      }
    }
    
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('cloning', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'cloning' });
    
    addLog(sessionId, `📝 Setting server name to: ${source.name}`);
    await target.setName(source.name);
    if (source.icon) {
      addLog(sessionId, '🖼️ Setting server icon...');
      await target.setIcon(source.iconURL({ dynamic: true }));
    }
    
    const roles = [...source.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .filter(r => r.name !== '@everyone');
    
    addLog(sessionId, `➕ Creating ${roles.length} roles...`);
    
    for (const role of roles) {
      try {
        const newRole = await target.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          permissions: role.permissions.bitfield,
          mentionable: role.mentionable
        });
        addLog(sessionId, `✅ Role created: ${newRole.name}`);
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        addLog(sessionId, `⚠️ Failed to create role ${role.name}: ${e.message}`);
      }
    }
    
    const channels = [...source.channels.cache.values()].sort((a, b) => a.position - b.position);
    const categoryMap = new Map();
    
    const categories = channels.filter(c => c.type === 4);
    addLog(sessionId, `📁 Creating ${categories.length} categories...`);
    
    for (const channel of categories) {
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
        addLog(sessionId, `✅ Category created: ${newCat.name}`);
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        addLog(sessionId, `⚠️ Failed to create category ${channel.name}: ${e.message}`);
      }
    }
    
    const otherChannels = channels.filter(c => c.type !== 4);
    addLog(sessionId, `📋 Creating ${otherChannels.length} channels...`);
    
    for (const channel of otherChannels) {
      try {
        const newChannel = await target.channels.create({
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
        const typeName = channel.type === 0 ? 'text' : channel.type === 2 ? 'voice' : 'channel';
        addLog(sessionId, `✅ ${typeName} created: #${newChannel.name}`);
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        addLog(sessionId, `⚠️ Failed to create channel ${channel.name}: ${e.message}`);
      }
    }
    
    selfClient.destroy();
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('completed', sessionId);
    addLog(sessionId, '🎉 Clone completed successfully!');
    broadcast({ type: 'complete', id: sessionId });
  } catch (err) {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('error', sessionId);
    addLog(sessionId, `💥 Error: ${err.message}`);
    broadcast({ type: 'error', id: sessionId, message: err.message });
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
