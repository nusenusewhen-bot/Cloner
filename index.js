const { Client: SelfClient } = require('discord.js-selfbot-v13');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const Database = require('better-sqlite3');
const { getSuperProperties } = require('./superprops');

const db = new Database('./clones.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, uses INTEGER DEFAULT 1, active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS access (user_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS sessions (user_id TEXT PRIMARY KEY, token TEXT, source_guild TEXT, target_guild TEXT, source_name TEXT, target_name TEXT);
`);

const OWNER_ID = '1422945082746601594';
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN not found in environment variables');
  process.exit(1);
}

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

function generateKey() {
  return 'CLONE-' + Math.random().toString(36).substring(2, 15).toUpperCase();
}

const commands = [
  new SlashCommandBuilder().setName('clonekey').setDescription('Generate clone key').setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('revoke').setDescription('Revoke a key').addStringOption(opt => opt.setName('key').setDescription('Key to revoke').setRequired(true)).setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('access').setDescription('Give unlimited access').addUserOption(opt => opt.setName('user').setDescription('User').setRequired(true)).setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('redeemkey').setDescription('Redeem a clone key').addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true)),
  new SlashCommandBuilder().setName('serverclone').setDescription('Open clone panel')
];

bot.once('ready', async () => {
  console.log(`Logged in as ${bot.user.tag}`);
  console.log(`Bot ID: ${bot.user.id}`);
  
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(bot.user.id), { body: commands.map(c => c.toJSON()) });
    console.log('Commands registered successfully');
  } catch (err) {
    console.error('Command registration failed:', err.message);
  }
});

async function updatePanel(interaction, userId) {
  const session = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(userId) || {};
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('copy_server').setLabel('Copy Server').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('clone_here').setLabel('Clone Here').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('start_clone').setLabel('Start').setStyle(ButtonStyle.Success)
  );
  
  const embed = new EmbedBuilder()
    .setTitle('Server Cloner')
    .setDescription('Configure your clone settings below')
    .addFields(
      { name: 'Token', value: session.token ? `✅ Set` : '❌ Not set', inline: false },
      { name: 'Source', value: session.source_name ? `✅ ${session.source_name}` : (session.source_guild ? `✅ ${session.source_guild}` : '❌ Not set'), inline: true },
      { name: 'Target', value: session.target_name ? `✅ ${session.target_name}` : (session.target_guild ? `✅ ${session.target_guild}` : '❌ Not set'), inline: true }
    );
  
  if (interaction.message) {
    return await interaction.update({ embeds: [embed], components: [row] });
  }
}

bot.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'clonekey') {
        if (interaction.user.id !== OWNER_ID) {
          return await interaction.reply({ content: 'No', ephemeral: true });
        }
        const key = generateKey();
        db.prepare('INSERT INTO keys (key) VALUES (?)').run(key);
        return await interaction.reply({ content: `Key: \`${key}\``, ephemeral: true });
      }
      
      if (interaction.commandName === 'revoke') {
        if (interaction.user.id !== OWNER_ID) {
          return await interaction.reply({ content: 'No', ephemeral: true });
        }
        const key = interaction.options.getString('key');
        db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(key);
        return await interaction.reply({ content: 'Revoked', ephemeral: true });
      }
      
      if (interaction.commandName === 'access') {
        if (interaction.user.id !== OWNER_ID) {
          return await interaction.reply({ content: 'No', ephemeral: true });
        }
        const user = interaction.options.getUser('user');
        db.prepare('INSERT OR REPLACE INTO access (user_id) VALUES (?)').run(user.id);
        return await interaction.reply({ content: `Gave access to ${user.tag}`, ephemeral: true });
      }
      
      if (interaction.commandName === 'redeemkey') {
        const key = interaction.options.getString('key');
        const keyData = db.prepare('SELECT * FROM keys WHERE key = ? AND active = 1').get(key);
        
        if (!keyData) {
          return await interaction.reply({ content: 'Invalid or used key', ephemeral: true });
        }
        
        db.prepare('INSERT OR REPLACE INTO access (user_id) VALUES (?)').run(interaction.user.id);
        db.prepare('UPDATE keys SET uses = uses - 1 WHERE key = ?').run(key);
        
        if (keyData.uses <= 1) {
          db.prepare('UPDATE keys SET active = 0 WHERE key = ?').run(key);
        }
        
        return await interaction.reply({ content: 'Key redeemed! You now have access to /serverclone', ephemeral: true });
      }
      
      if (interaction.commandName === 'serverclone') {
        const hasAccess = db.prepare('SELECT * FROM access WHERE user_id = ?').get(interaction.user.id);
        
        if (!hasAccess) {
          return await interaction.reply({ content: 'You need to redeem a key first using /redeemkey', ephemeral: true });
        }
        
        const session = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(interaction.user.id) || {};
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('set_token').setLabel('Set Token').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('copy_server').setLabel('Copy Server').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('clone_here').setLabel('Clone Here').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('start_clone').setLabel('Start').setStyle(ButtonStyle.Success)
        );
        
        const embed = new EmbedBuilder()
          .setTitle('Server Cloner')
          .setDescription('Configure your clone settings below')
          .addFields(
            { name: 'Token', value: session.token ? `✅ Set` : '❌ Not set', inline: false },
            { name: 'Source', value: session.source_name ? `✅ ${session.source_name}` : (session.source_guild ? `✅ ${session.source_guild}` : '❌ Not set'), inline: true },
            { name: 'Target', value: session.target_name ? `✅ ${session.target_name}` : (session.target_guild ? `✅ ${session.target_guild}` : '❌ Not set'), inline: true }
          );
        
        return await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      }
    }
    
    if (interaction.isButton()) {
      if (interaction.customId === 'set_token') {
        const modal = new ModalBuilder().setCustomId('token_modal').setTitle('Set Token');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('token').setLabel('User Token').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return await interaction.showModal(modal);
      }
      
      if (interaction.customId === 'copy_server') {
        const modal = new ModalBuilder().setCustomId('source_modal').setTitle('Source Server');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guild_id').setLabel('Server ID to Copy').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return await interaction.showModal(modal);
      }
      
      if (interaction.customId === 'clone_here') {
        const modal = new ModalBuilder().setCustomId('target_modal').setTitle('Target Server');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guild_id').setLabel('Server ID to Clone To').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return await interaction.showModal(modal);
      }
      
      if (interaction.customId === 'start_clone') {
        const session = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(interaction.user.id);
        if (!session || !session.token || !session.source_guild || !session.target_guild) {
          return await interaction.reply({ content: 'Set all fields first', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        
        const selfClient = new SelfClient({ checkUpdate: false });
        selfClient.options.http.api = 'https://discord.com/api/v9';
        selfClient.options.ws.properties = getSuperProperties();
        
        try {
          await selfClient.login(session.token);
          
          const sourceGuild = await selfClient.guilds.fetch(session.source_guild);
          const targetGuild = await selfClient.guilds.fetch(session.target_guild);
          
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
                mentionable: role.mentionable,
                position: role.position
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
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(interaction.user.id);
          
          return await interaction.editReply({ content: '✅ Clone complete! Server copied successfully.' });
        } catch (err) {
          return await interaction.editReply({ content: `Error: ${err.message}` });
        }
      }
    }
    
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'token_modal') {
        const token = interaction.fields.getTextInputValue('token');
        const selfClient = new SelfClient({ checkUpdate: false });
        selfClient.options.ws.properties = getSuperProperties();
        
        try {
          await selfClient.login(token);
          const user = selfClient.user;
          selfClient.destroy();
          
          const existing = db.prepare('SELECT source_guild, target_guild, source_name, target_name FROM sessions WHERE user_id = ?').get(interaction.user.id);
          
          db.prepare('INSERT OR REPLACE INTO sessions (user_id, token, source_guild, target_guild, source_name, target_name) VALUES (?, ?, ?, ?, ?, ?)')
            .run(
              interaction.user.id, 
              token, 
              existing?.source_guild || '', 
              existing?.target_guild || '',
              existing?.source_name || '',
              existing?.target_name || ''
            );
          
          await interaction.reply({ content: `✅ Logged in as @${user.username}`, ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        } catch (e) {
          console.error('Token validation error:', e);
          return await interaction.reply({ content: `❌ Invalid token`, ephemeral: true });
        }
      }
      
      if (interaction.customId === 'source_modal') {
        const guildId = interaction.fields.getTextInputValue('guild_id');
        const session = db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(interaction.user.id);
        
        if (!session || !session.token) {
          db.prepare('UPDATE sessions SET source_guild = ? WHERE user_id = ?').run(guildId, interaction.user.id);
          await interaction.reply({ content: '✅ Source server set', ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        }
        
        const selfClient = new SelfClient({ checkUpdate: false });
        selfClient.options.ws.properties = getSuperProperties();
        
        try {
          await selfClient.login(session.token);
          const guild = await selfClient.guilds.fetch(guildId);
          selfClient.destroy();
          
          db.prepare('UPDATE sessions SET source_guild = ?, source_name = ? WHERE user_id = ?').run(guildId, guild.name, interaction.user.id);
          await interaction.reply({ content: `✅ Source set: ${guild.name}`, ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        } catch (e) {
          db.prepare('UPDATE sessions SET source_guild = ? WHERE user_id = ?').run(guildId, interaction.user.id);
          await interaction.reply({ content: `✅ Source set`, ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        }
      }
      
      if (interaction.customId === 'target_modal') {
        const guildId = interaction.fields.getTextInputValue('guild_id');
        const session = db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(interaction.user.id);
        
        if (!session || !session.token) {
          db.prepare('UPDATE sessions SET target_guild = ? WHERE user_id = ?').run(guildId, interaction.user.id);
          await interaction.reply({ content: '✅ Target server set', ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        }
        
        const selfClient = new SelfClient({ checkUpdate: false });
        selfClient.options.ws.properties = getSuperProperties();
        
        try {
          await selfClient.login(session.token);
          const guild = await selfClient.guilds.fetch(guildId);
          selfClient.destroy();
          
          db.prepare('UPDATE sessions SET target_guild = ?, target_name = ? WHERE user_id = ?').run(guildId, guild.name, interaction.user.id);
          await interaction.reply({ content: `✅ Target set: ${guild.name}`, ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        } catch (e) {
          db.prepare('UPDATE sessions SET target_guild = ? WHERE user_id = ?').run(guildId, interaction.user.id);
          await interaction.reply({ content: `✅ Target set`, ephemeral: true });
          try {
            return await updatePanel(interaction, interaction.user.id);
          } catch (e) {
            return;
          }
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'An error occurred', ephemeral: true });
      } else {
        await interaction.reply({ content: 'An error occurred', ephemeral: true });
      }
    } catch (e) {}
  }
});

bot.login(BOT_TOKEN).catch(err => {
  console.error('Failed to login:', err.message);
  process.exit(1);
});
