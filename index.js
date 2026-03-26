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
  console.log(`[${sessionId}] ${message}`);
  const session = db.prepare('SELECT logs FROM sessions WHERE id = ?').get(sessionId);
  const logs = JSON.parse(session?.logs || '[]');
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  db.prepare('UPDATE sessions SET logs = ? WHERE id = ?').run(JSON.stringify(logs.slice(0, 100)), sessionId);
  broadcast({ type: 'log', id: sessionId, message });
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
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
  
  selfClient.on('error', (err) => {
    addLog(sessionId, `💥 Client error: ${err.message}`);
  });
  
  selfClient.on('disconnect', () => {
    addLog(sessionId, '⚠️ Client disconnected');
  });
  
  selfClient.on('debug', (msg) => {
    console.log(`[DEBUG ${sessionId}] ${msg}`);
  });
  
  try {
    addLog(sessionId, '🔑 Logging in...');
    addLog(sessionId, '⏱️ Timeout set to 15 seconds');
    
    const loginPromise = selfClient.login(token);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Login timeout - check token validity')), 15000);
    });
    
    await Promise.race([loginPromise, timeoutPromise]);
    
    addLog(sessionId, `✅ Logged in as ${selfClient.user.tag} (${selfClient.user.id})`);
    addLog(sessionId, '📡 Fetching source guild...');
    
    const source = await selfClient.guilds.fetch(sourceGuild, { force: true });
    addLog(sessionId, `✅ Source: ${source.name} (${source.id})`);
    
    addLog(sessionId, '📡 Fetching target guild...');
    const target = await selfClient.guilds.fetch(targetGuild, { force: true });
    addLog(sessionId, `✅ Target: ${target.name} (${target.id})`);
    
    db.prepare('UPDATE sessions SET source_name = ?, target_name = ?, status = ? WHERE id = ?')
      .run(source.name, target.name, 'deleting', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'deleting' });
    
    await target.channels.fetch({ force: true });
    await target.roles.fetch({ force: true });
    
    const existingRoles = [...target.roles.cache.values()].filter(r => r.name !== '@everyone' && r.editable);
    addLog(sessionId, `🗑️ Deleting ${existingRoles.length} roles...`);
    
    for (const role of existingRoles) {
      try { 
        await role.delete(); 
        addLog(sessionId, `❌ Role deleted: ${role.name}`);
        await new Promise(r => setTimeout(r, 300)); 
      } catch (e) {
        addLog(sessionId, `⚠️ Role ${role.name}: ${e.message}`);
      }
    }
    
    const existingChannels = [...target.channels.cache.values()];
    addLog(sessionId, `🗑️ Deleting ${existingChannels.length} channels...`);
    
    for (const channel of existingChannels) {
      try { 
        await channel.delete(); 
        addLog(sessionId, `❌ Channel deleted: #${channel.name}`);
        await new Promise(r => setTimeout(r, 300)); 
      } catch (e) {
        addLog(sessionId, `⚠️ Channel #${channel.name}: ${e.message}`);
      }
    }
    
    await new Promise(r => setTimeout(r, 1000));
    addLog(sessionId, '🔄 Refreshing cache...');
    const freshTarget = await selfClient.guilds.fetch(targetGuild, { force: true });
    await freshTarget.channels.fetch({ force: true });
    
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('cloning', sessionId);
    broadcast({ type: 'status', id: sessionId, status: 'cloning' });
    
    addLog(sessionId, `📝 Setting name: ${source.name}`);
    await freshTarget.setName(source.name);
    
    if (source.icon) {
      addLog(sessionId, '🖼️ Setting icon...');
      await freshTarget.setIcon(source.iconURL({ dynamic: true }));
    }
    
    const roles = [...source.roles.cache.values()]
      .sort((a, b) => b.position - a.position)
      .filter(r => r.name !== '@everyone');
    
    addLog(sessionId, `➕ Creating ${roles.length} roles...`);
    
    for (const role of roles) {
      try {
        const newRole = await freshTarget.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          permissions: role.permissions.bitfield,
          mentionable: role.mentionable
        });
        addLog(sessionId, `✅ Role: ${newRole.name}`);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        addLog(sessionId, `⚠️ Role ${role.name}: ${e.message}`);
      }
    }
    
    await source.channels.fetch({ force: true });
    const channels = [...source.channels.cache.values()].sort((a, b) => a.position - b.position);
    
    const categoryMap = new Map();
    const categories = channels.filter(c => c.type === 4);
    
    addLog(sessionId, `📁 Creating ${categories.length} categories...`);
    
    for (const cat of categories) {
      try {
        const newCat = await freshTarget.channels.create({
          name: cat.name,
          type: 4,
          position: cat.position,
          permissionOverwrites: cat.permissionOverwrites.cache.map(o => ({
            id: o.id,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString()
          }))
        });
        categoryMap.set(cat.id, newCat.id);
        addLog(sessionId, `✅ Category: ${newCat.name}`);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        addLog(sessionId, `⚠️ Category ${cat.name}: ${e.message}`);
      }
    }
    
    const otherChannels = channels.filter(c => c.type !== 4);
    addLog(sessionId, `📋 Creating ${otherChannels.length} channels...`);
    
    for (const ch of otherChannels) {
      try {
        const parentId = ch.parentId ? categoryMap.get(ch.parentId) : null;
        
        const newCh = await freshTarget.channels.create({
          name: ch.name,
          type: ch.type,
          position: ch.position,
          topic: ch.topic || undefined,
          nsfw: ch.nsfw || undefined,
          bitrate: ch.bitrate || undefined,
          userLimit: ch.userLimit || undefined,
          parent: parentId,
          permissionOverwrites: ch.permissionOverwrites.cache.map(o => ({
            id: o.id,
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString()
          }))
        });
        
        const icon = ch.type === 0 ? '💬' : ch.type === 2 ? '🔊' : ch.type === 5 ? '📢' : '📝';
        addLog(sessionId, `${icon} #${newCh.name}`);
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        addLog(sessionId, `⚠️ #${ch.name}: ${e.message}`);
      }
    }
    
    selfClient.destroy();
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('completed', sessionId);
    addLog(sessionId, '🎉 Complete!');
    broadcast({ type: 'complete', id: sessionId });
  } catch (err) {
    console.error(`[ERROR ${sessionId}]`, err);
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('error', sessionId);
    addLog(sessionId, `💥 Error: ${err.message}`);
    broadcast({ type: 'error', id: sessionId, message: err.message });
    try { selfClient.destroy(); } catch (e) {}
  }
});

wss.on('connection', (ws) => {});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
