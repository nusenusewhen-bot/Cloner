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

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT,
  source_guild TEXT,
  target_guild TEXT,
  source_name TEXT,
  target_name TEXT,
  status TEXT DEFAULT 'idle',
  logs TEXT DEFAULT '[]'
)`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 10').all();
  res.json(sessions);
});

function addLog(sessionId, message) {
  console.log(`[${sessionId}] ${message}`);
  const session = db.prepare('SELECT logs FROM sessions WHERE id = ?').get(sessionId);
  const logs = JSON.parse(session?.logs || '[]');
  logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  db.prepare('UPDATE sessions SET logs = ? WHERE id = ?')
    .run(JSON.stringify(logs.slice(0, 100)), sessionId);
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

  const result = db.prepare(
    'INSERT INTO sessions (token, source_guild, target_guild, logs) VALUES (?, ?, ?, ?)'
  ).run(token, sourceGuild, targetGuild, '[]');

  const sessionId = result.lastInsertRowid;

  res.json({ success: true, id: sessionId });
  setImmediate(() => runClone(sessionId, token, sourceGuild, targetGuild));
});

async function runClone(sessionId, token, sourceGuild, targetGuild) {
  const selfClient = new SelfClient({ 
    checkUpdate: false,
    autoRedeemNitro: false,
    ws: {
      properties: getSuperProperties()
    }
  });

  try {
    addLog(sessionId, '🔑 Logging in...');
    
    await selfClient.login(token);
    
    addLog(sessionId, `✅ Logged in as ${selfClient.user.tag}`);

    const source = await selfClient.guilds.fetch(sourceGuild, { force: true }).catch(e => {
      throw new Error(`Cannot access source server: ${e.message}`);
    });
    
    const target = await selfClient.guilds.fetch(targetGuild, { force: true }).catch(e => {
      throw new Error(`Cannot access target server: ${e.message}`);
    });

    addLog(sessionId, `✅ Source: ${source.name} | Target: ${target.name}`);

    db.prepare('UPDATE sessions SET source_name = ?, target_name = ?, status = ? WHERE id = ?')
      .run(source.name, target.name, 'deleting', sessionId);

    broadcast({ type: 'status', id: sessionId, status: 'deleting' });

    await target.channels.fetch();
    await target.roles.fetch();

    for (const [, role] of target.roles.cache.filter(r => r.name !== '@everyone' && r.editable)) {
      try {
        await role.delete();
        addLog(sessionId, `❌ Role: ${role.name}`);
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        addLog(sessionId, `⚠️ Failed to delete role ${role.name}: ${err.message}`);
      }
    }

    for (const channel of target.channels.cache.values()) {
      try {
        await channel.delete();
        addLog(sessionId, `❌ Channel: #${channel.name}`);
        await new Promise(r => setTimeout(r, 350));
      } catch (err) {
        addLog(sessionId, `⚠️ Failed to delete channel #${channel.name}: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 1000));

    const freshTarget = await selfClient.guilds.fetch(targetGuild, { force: true });

    db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run('cloning', sessionId);

    broadcast({ type: 'status', id: sessionId, status: 'cloning' });

    await freshTarget.setName(source.name);

    if (source.icon) {
      try {
        await freshTarget.setIcon(source.iconURL({ dynamic: true }));
        addLog(sessionId, '🖼️ Icon copied');
      } catch (err) {
        addLog(sessionId, `⚠️ Failed to copy icon: ${err.message}`);
      }
    }

    selfClient.destroy();

    db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run('completed', sessionId);

    addLog(sessionId, '🎉 Complete!');
    broadcast({ type: 'complete', id: sessionId });

  } catch (err) {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run('error', sessionId);

    addLog(sessionId, `💥 Error: ${err.message}`);
    broadcast({ type: 'error', id: sessionId, message: err.message });

    try { selfClient.destroy(); } catch {}
  }
}

server.listen(8080, '0.0.0.0', () => {
  console.log('Server on 8080');
});
