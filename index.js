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
  logs TEXT DEFAULT '[]',
  options TEXT DEFAULT '{}'
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

app.get('/api/session/:id', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.json({ error: 'Not found' });
  res.json({
    id: session.id,
    status: session.status,
    logs: JSON.parse(session.logs || '[]'),
    options: JSON.parse(session.options || '{}')
  });
});

function addLog(sessionId, message) {
  const timestamp = new Date().toLocaleTimeString();
  const logMessage = `[${timestamp}] ${message}`;
  
  console.log(`[Session ${sessionId}] ${logMessage}`);
  
  const session = db.prepare('SELECT logs FROM sessions WHERE id = ?').get(sessionId);
  const logs = JSON.parse(session?.logs || '[]');
  logs.unshift(logMessage);
  db.prepare('UPDATE sessions SET logs = ? WHERE id = ?')
    .run(JSON.stringify(logs.slice(0, 100)), sessionId);
    
  broadcast({ type: 'log', id: sessionId, message: logMessage });
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

app.post('/api/clone', async (req, res) => {
  const { token, sourceGuild, targetGuild, options } = req.body;
  if (!token || !sourceGuild || !targetGuild) {
    return res.json({ error: 'Missing fields' });
  }

  const opts = options || { all: true, banner: true, icon: true, channels: true, roles: true };

  const result = db.prepare(
    'INSERT INTO sessions (token, source_guild, target_guild, logs, options) VALUES (?, ?, ?, ?, ?)'
  ).run(token, sourceGuild, targetGuild, '[]', JSON.stringify(opts));

  const sessionId = result.lastInsertRowid;

  res.json({ success: true, id: sessionId });
  setImmediate(() => runClone(sessionId, token, sourceGuild, targetGuild, opts));
});

async function runClone(sessionId, token, sourceGuild, targetGuild, options) {
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

    const botMember = await target.members.fetch(selfClient.user.id);
    const botHighestRole = botMember.roles.highest;

    const shouldDoRoles = options.all === true || options.roles !== false;
    const shouldDoChannels = options.all === true || options.channels !== false;
    const shouldDoIcon = options.all === true || options.icon !== false;
    const shouldDoBanner = options.all === true || options.banner !== false;

    // DELETE ROLES
    if (shouldDoRoles) {
      addLog(sessionId, '🗑️ Deleting old roles...');
      
      const rolesToDelete = target.roles.cache
        .filter(r => r.name !== '@everyone' && r.id !== target.roles.everyone.id)
        .sort((a, b) => b.position - a.position);

      addLog(sessionId, `Found ${rolesToDelete.size} roles to delete`);

      for (const [, role] of rolesToDelete) {
        try {
          if (botHighestRole.position <= role.position) {
            addLog(sessionId, `⚠️ Cannot delete ${role.name} - higher than bot`);
            continue;
          }
          
          await role.delete();
          addLog(sessionId, `❌ Deleted role: ${role.name}`);
          await new Promise(r => setTimeout(r, 400));
        } catch (err) {
          addLog(sessionId, `⚠️ Failed to delete role ${role.name}: ${err.message}`);
        }
      }
    }

    // DELETE CHANNELS
    if (shouldDoChannels) {
      addLog(sessionId, '🗑️ Deleting old channels...');
      for (const channel of target.channels.cache.values()) {
        try {
          await channel.delete();
          addLog(sessionId, `❌ Deleted channel: #${channel.name}`);
          await new Promise(r => setTimeout(r, 350));
        } catch (err) {
          addLog(sessionId, `⚠️ Failed to delete channel #${channel.name}: ${err.message}`);
        }
      }
    }

    await new Promise(r => setTimeout(r, 1000));

    const freshTarget = await selfClient.guilds.fetch(targetGuild, { force: true });

    db.prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run('cloning', sessionId);

    broadcast({ type: 'status', id: sessionId, status: 'cloning' });

    await freshTarget.setName(source.name);

    // COPY ICON
    if (shouldDoIcon && source.icon) {
      try {
        await freshTarget.setIcon(source.iconURL({ dynamic: true }));
        addLog(sessionId, '🖼️ Icon copied');
      } catch (err) {
        addLog(sessionId, `⚠️ Failed to copy icon: ${err.message}`);
      }
    }

    // COPY BANNER
    if (shouldDoBanner && source.banner) {
      try {
        await freshTarget.setBanner(source.bannerURL({ dynamic: true }));
        addLog(sessionId, '🎨 Banner copied');
      } catch (err) {
        addLog(sessionId, `⚠️ Failed to copy banner: ${err.message}`);
      }
    }

    // If only icon/banner, finish early
    if (!shouldDoRoles && !shouldDoChannels) {
      addLog(sessionId, '🎉 Clone complete! (Server info only)');
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('completed', sessionId);
      broadcast({ type: 'complete', id: sessionId });
      selfClient.destroy();
      return;
    }

    await source.roles.fetch();
    await source.channels.fetch();

    const roleMap = new Map();
    
    // CREATE ROLES
    if (shouldDoRoles) {
      addLog(sessionId, '🎭 Creating roles...');
      
      const sortedRoles = source.roles.cache
        .filter(r => r.name !== '@everyone')
        .sort((a, b) => b.position - a.position);

      for (const [, role] of sortedRoles) {
        try {
          const newRole = await freshTarget.roles.create({
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            mentionable: role.mentionable,
            permissions: role.permissions.bitfield
          });
          roleMap.set(role.id, newRole);
          addLog(sessionId, `✅ Created role: ${role.name}`);
          await new Promise(r => setTimeout(r, 400));
        } catch (err) {
          addLog(sessionId, `❌ Failed to create role ${role.name}: ${err.message}`);
        }
      }
    }

    const everyoneRole = freshTarget.roles.everyone;

    // CREATE CATEGORIES & CHANNELS
    if (shouldDoChannels) {
      addLog(sessionId, '📁 Creating categories...');
      const categoryMap = new Map();
      
      const categories = source.channels.cache
        .filter(c => c.type === 'GUILD_CATEGORY')
        .sort((a, b) => a.position - b.position);

      for (const [, category] of categories) {
        try {
          const permissionOverwrites = category.permissionOverwrites.cache.map(overwrite => {
            const roleId = overwrite.id === source.roles.everyone.id 
              ? everyoneRole.id 
              : (roleMap.get(overwrite.id)?.id || overwrite.id);
            
            return {
              id: roleId,
              allow: overwrite.allow.bitfield,
              deny: overwrite.deny.bitfield,
              type: overwrite.type
            };
          });

          const newCategory = await freshTarget.channels.create(category.name, {
            type: 'GUILD_CATEGORY',
            permissionOverwrites: permissionOverwrites
          });
          
          categoryMap.set(category.id, newCategory);
          addLog(sessionId, `✅ Created category: ${category.name}`);
          await new Promise(r => setTimeout(r, 350));
        } catch (err) {
          addLog(sessionId, `❌ Failed to create category ${category.name}: ${err.message}`);
        }
      }

      addLog(sessionId, '💬 Creating channels...');
      
      const channels = source.channels.cache
        .filter(c => c.type !== 'GUILD_CATEGORY' && !c.name.toLowerCase().startsWith('ticket-'))
        .sort((a, b) => a.position - b.position);

      for (const [, channel] of channels) {
        try {
          const parentId = channel.parentId ? categoryMap.get(channel.parentId)?.id : null;
          
          const permissionOverwrites = channel.permissionOverwrites.cache.map(overwrite => {
            const roleId = overwrite.id === source.roles.everyone.id 
              ? everyoneRole.id 
              : (roleMap.get(overwrite.id)?.id || overwrite.id);
            
            return {
              id: roleId,
              allow: overwrite.allow.bitfield,
              deny: overwrite.deny.bitfield,
              type: overwrite.type
            };
          });

          const channelData = {
            type: channel.type,
            topic: channel.topic || undefined,
            nsfw: channel.nsfw || undefined,
            parent: parentId || undefined,
            permissionOverwrites: permissionOverwrites
          };

          if (channel.type === 'GUILD_TEXT') {
            channelData.rateLimitPerUser = channel.rateLimitPerUser || undefined;
          }
          
          if (channel.type === 'GUILD_VOICE') {
            channelData.bitrate = channel.bitrate || undefined;
            channelData.userLimit = channel.userLimit || undefined;
          }

          await freshTarget.channels.create(channel.name, channelData);
          addLog(sessionId, `✅ Created channel: #${channel.name}`);
          await new Promise(r => setTimeout(r, 350));
        } catch (err) {
          addLog(sessionId, `❌ Failed to create channel #${channel.name}: ${err.message}`);
        }
      }
    }

    addLog(sessionId, '🎉 Clone complete!');
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('completed', sessionId);
    broadcast({ type: 'complete', id: sessionId });

    selfClient.destroy();

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
