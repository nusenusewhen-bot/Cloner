const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Client: SelfClient } = require('discord.js-selfbot-v13');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, Partials } = require('discord.js');
const Database = require('better-sqlite3');
const { getSuperProperties } = require('./superprops');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new Database('./clones.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, uses INTEGER DEFAULT 1, active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS access (user_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS sessions (user_id TEXT PRIMARY KEY, token TEXT, source_guild TEXT, target_guild TEXT, source_name TEXT, target_name TEXT);
`);

const OWNER_ID = '1422945082746601594';
const BOT_TOKEN = process.env.BOT_TOKEN;
const PREFIX = '!';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN not found');
  process.exit(1);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => {
  const keys = db.prepare('SELECT COUNT(*) as count FROM keys').get();
  const access = db.prepare('SELECT COUNT(*) as count FROM access').get();
  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get();
  res.json({ 
    bot: bot.user?.tag || 'Starting', 
    keys: keys.count, 
    users: access.count, 
    activeSessions: sessions.count,
    uptime: process.uptime()
  });
});

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'generateKey' && msg.userId === OWNER_ID) {
        const key = 'CLONE-' + Math.random().toString(36).substring(2, 15).toUpperCase();
        db.prepare('INSERT INTO keys (key) VALUES (?)').run(key);
        broadcast({ type: 'newKey', key });
      }
    } catch (e) {}
  });
});

function broadcast(data) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function generateKey() {
  return 'CLONE-' + Math.random().toString(36).substring(2, 15).toUpperCase();
}

bot.once('ready', () => {
  console.log(`Logged in as ${bot.user.tag}`);
  broadcast({ type: 'status', bot: bot.user.tag, status: 'online' });
});

async function sendClonePanel(channel, userId) {
  const session = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId) || {};
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set_token_' + userId).setLabel('Set Token').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('copy_server_' + userId).setLabel('Copy Server').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('clone_here_' + userId).setLabel('Clone Here').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('start_clone_' + userId).setLabel('Start').setStyle(ButtonStyle.Success)
  );
  
  const embed = new EmbedBuilder()
    .setTitle('Server Cloner')
    .setDescription('Configure your clone settings below')
    .addFields(
      { name: 'Token', value: session.token ? `✅ Set` : '❌ Not set', inline: false },
      { name: 'Source', value: session.source_name || session.source_guild || '❌ Not set', inline: true },
      { name: 'Target', value: session.target_name || session.target_guild || '❌ Not set', inline: true }
    );
  
  return await channel.send({ embeds: [embed], components: [row] });
}

bot.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
  
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  if (command === 'clonekey') {
    if (message.author.id !== OWNER_ID) return message.reply('No');
    const key = generateKey();
    db.prepare('INSERT INTO keys (key) VALUES (?)').run(key);
    broadcast({ type: 'newKey', key, by: message.author.tag });
    return message.reply(`Key: \`${key}\``);
  }
  
  if (command === 'revoke') {
    if (message.author.id !== OWNER_ID) return message.reply('No');
    const key = args[0];
    if (!key) return message.reply('Provide key');
    db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(key);
    return message.reply('Revoked');
  }
  
  if (command === 'access') {
    if (message.author.id !== OWNER_ID) return message.reply('No');
    const user = message.mentions.users.first();
    if (!user) return message.reply('Mention user');
    db.prepare('INSERT OR REPLACE INTO access (user_id) VALUES (?)').run(user.id);
    return message.reply(`Gave access to ${user.tag}`);
  }
  
  if (command === 'redeemkey') {
    const key = args[0];
    if (!key) return message.reply('Provide key');
    const keyData = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(key);
    if (!keyData) return message.reply('Invalid key');
    
    db.prepare('INSERT OR REPLACE INTO access (user_id) VALUES (?)').run(message.author.id);
    db.prepare('UPDATE keys SET uses = uses - 1 WHERE key = ?').run(key);
    if (keyData.uses <= 1) db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(key);
    
    broadcast({ type: 'keyRedeemed', user: message.author.tag, key });
    return message.reply('Key redeemed! Use !serverclone');
  }
  
  if (command === 'serverclone') {
    const hasAccess = db.prepare('SELECT * FROM access WHERE user_id = ?').get(message.author.id);
    if (!hasAccess) return message.reply('Redeem key first with !redeemkey <key>');
    
    return await sendClonePanel(message.channel, message.author.id);
  }
});

bot.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;
  
  const userId = interaction.user.id;
  const customId = interaction.customId;
  
  if (!customId.endsWith('_' + userId) && !customId.includes('_modal_')) {
    return interaction.reply({ content: 'Not your panel', ephemeral: true }).catch(() => {});
  }
  
  try {
    if (interaction.isButton()) {
      if (customId.startsWith('set_token_')) {
        const modal = new ModalBuilder().setCustomId('token_modal_' + userId).setTitle('Set Token');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('token').setLabel('User Token').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return await interaction.showModal(modal);
      }
      
      if (customId.startsWith('copy_server_')) {
        const modal = new ModalBuilder().setCustomId('source_modal_' + userId).setTitle('Source Server');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guild_id').setLabel('Server ID to Copy').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return await interaction.showModal(modal);
      }
      
      if (customId.startsWith('clone_here_')) {
        const modal = new ModalBuilder().setCustomId('target_modal_' + userId).setTitle('Target Server');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guild_id').setLabel('Server ID to Clone To').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return await interaction.showModal(modal);
      }
      
      if (customId.startsWith('start_clone_')) {
        const session = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId);
        if (!session?.token || !session?.source_guild || !session?.target_guild) {
          return await interaction.reply({ content: 'Set all fields first', ephemeral: true }).catch(() => {});
        }
        
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        broadcast({ type: 'cloneStart', user: interaction.user.tag });
        
        const selfClient = new SelfClient({ checkUpdate: false });
        selfClient.options.http.api = 'https://discord.com/api/v9';
        selfClient.options.ws.properties = getSuperProperties();
        
        try {
          await selfClient.login(session.token);
          
          const sourceGuild = await selfClient.guilds.fetch(session.source_guild);
          const targetGuild = await selfClient.guilds.fetch(session.target_guild);
          
          await interaction.editReply({ content: '🔴 Deleting existing roles and channels...' }).catch(() => {});
          broadcast({ type: 'cloneProgress', step: 'deleting', user: interaction.user.tag });
          
          const existingRoles = targetGuild.roles.cache.filter(r => r.name !== '@everyone' && r.editable);
          for (const [, role] of existingRoles) {
            try { await role.delete(); await new Promise(r => setTimeout(r, 200)); } catch (e) {}
          }
          
          const existingChannels = [...targetGuild.channels.cache.values()];
          for (const channel of existingChannels) {
            try { await channel.delete(); await new Promise(r => setTimeout(r, 200)); } catch (e) {}
          }
          
          await interaction.editReply({ content: '🟡 Cloning server...' }).catch(() => {});
          broadcast({ type: 'cloneProgress', step: 'cloning', user: interaction.user.tag });
          
          await targetGuild.setName(sourceGuild.name);
          if (sourceGuild.icon) await targetGuild.setIcon(sourceGuild.iconURL({ dynamic: true }));
          
          const roles = [...sourceGuild.roles.cache.values()]
            .sort((a, b) => b.position - a.position)
            .filter(r => r.name !== '@everyone');
          
          for (const role of roles) {
            try {
              await targetGuild.roles.create({
                name: role.name,
                color: role.color,
                hoist: role.hoist,
                permissions: role.permissions.bitfield,
                mentionable: role.mentionable
              });
              await new Promise(r => setTimeout(r, 350));
            } catch (e) {}
          }
          
          const channels = [...sourceGuild.channels.cache.values()].sort((a, b) => a.position - b.position);
          const categoryMap = new Map();
          
          for (const channel of channels) {
            if (channel.type === 4) {
              try {
                const newCat = await targetGuild.channels.create({
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
                await targetGuild.channels.create({
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
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
          
          broadcast({ type: 'cloneComplete', user: interaction.user.tag, source: sourceGuild.name, target: targetGuild.name });
          return await interaction.editReply({ content: '✅ Clone complete!' }).catch(() => {});
        } catch (err) {
          broadcast({ type: 'cloneError', user: interaction.user.tag, error: err.message });
          return await interaction.editReply({ content: `Error: ${err.message}` }).catch(() => {});
        }
      }
    }
    
    if (interaction.isModalSubmit()) {
      if (customId.startsWith('token_modal_')) {
        const token = interaction.fields.getTextInputValue('token');
        const selfClient = new SelfClient({ checkUpdate: false });
        selfClient.options.ws.properties = getSuperProperties();
        
        try {
          await selfClient.login(token);
          const user = selfClient.user;
          selfClient.destroy();
          
          const existing = db.prepare('SELECT source_guild, target_guild, source_name, target_name FROM sessions WHERE user_id = ?').get(userId) || {};
          
          db.prepare('INSERT OR REPLACE INTO sessions (user_id, token, source_guild, target_guild, source_name, target_name) VALUES (?, ?, ?, ?, ?, ?)')
            .run(userId, token, existing.source_guild || '', existing.target_guild || '', existing.source_name || '', existing.target_name || '');
          
          broadcast({ type: 'tokenSet', user: user.username });
          return await interaction.reply({ content: `✅ Logged in as @${user.username}`, ephemeral: true }).catch(() => {});
        } catch (e) {
          return await interaction.reply({ content: '❌ Invalid token', ephemeral: true }).catch(() => {});
        }
      }
      
      if (customId.startsWith('source_modal_')) {
        const guildId = interaction.fields.getTextInputValue('guild_id');
        const session = db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(userId);
        
        db.prepare('UPDATE sessions SET source_guild = ? WHERE user_id = ?').run(guildId, userId);
        
        if (session?.token) {
          const selfClient = new SelfClient({ checkUpdate: false });
          selfClient.options.ws.properties = getSuperProperties();
          try {
            await selfClient.login(session.token);
            const guild = await selfClient.guilds.fetch(guildId);
            selfClient.destroy();
            db.prepare('UPDATE sessions SET source_name = ? WHERE user_id = ?').run(guild.name, userId);
            return await interaction.reply({ content: `✅ Source: ${guild.name}`, ephemeral: true }).catch(() => {});
          } catch (e) {
            return await interaction.reply({ content: `✅ Source set`, ephemeral: true }).catch(() => {});
          }
        } else {
          return await interaction.reply({ content: `✅ Source set`, ephemeral: true }).catch(() => {});
        }
      }
      
      if (customId.startsWith('target_modal_')) {
        const guildId = interaction.fields.getTextInputValue('guild_id');
        const session = db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(userId);
        
        db.prepare('UPDATE sessions SET target_guild = ? WHERE user_id = ?').run(guildId, userId);
        
        if (session?.token) {
          const selfClient = new SelfClient({ checkUpdate: false });
          selfClient.options.ws.properties = getSuperProperties();
          try {
            await selfClient.login(session.token);
            const guild = await selfClient.guilds.fetch(guildId);
            selfClient.destroy();
            db.prepare('UPDATE sessions SET target_name = ? WHERE user_id = ?').run(guild.name, userId);
            return await interaction.reply({ content: `✅ Target: ${guild.name}`, ephemeral: true }).catch(() => {});
          } catch (e) {
            return await interaction.reply({ content: `✅ Target set`, ephemeral: true }).catch(() => {});
          }
        } else {
          return await interaction.reply({ content: `✅ Target set`, ephemeral: true }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

bot.login(BOT_TOKEN).catch(err => {
  console.error('Failed to login:', err.message);
  process.exit(1);
});
