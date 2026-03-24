const { Client } = require('discord.js-selfbot-v13');
const { getSuperProperties } = require('./superprops');

const activeSessions = new Map();

module.exports = {
    createSession: (userId) => {
        const client = new Client({
            checkUpdate: false,
            patchVoice: false,
            http: {
                headers: {
                    'x-super-properties': Buffer.from(JSON.stringify(getSuperProperties())).toString('base64')
                }
            }
        });
        activeSessions.set(userId, { client, sourceId: null, targetId: null, token: null });
        return activeSessions.get(userId);
    },
    setToken: async (userId, token) => {
        const session = activeSessions.get(userId);
        if (!session) return null;
        session.token = token;
        try {
            await session.client.login(token);
            return session.client.user;
        } catch (e) {
            return null;
        }
    },
    setSource: (userId, guildId) => {
        const session = activeSessions.get(userId);
        if (session) session.sourceId = guildId;
    },
    setTarget: (userId, guildId) => {
        const session = activeSessions.get(userId);
        if (session) session.targetId = guildId;
    },
    executeClone: async (userId) => {
        const session = activeSessions.get(userId);
        if (!session || !session.client || !session.sourceId || !session.targetId) return false;
        
        const sourceGuild = session.client.guilds.cache.get(session.sourceId);
        const targetGuild = session.client.guilds.cache.get(session.targetId);
        
        if (!sourceGuild || !targetGuild) return false;

        try {
            await targetGuild.setName(sourceGuild.name);
            if (sourceGuild.iconURL()) await targetGuild.setIcon(sourceGuild.iconURL({ dynamic: true }));
            
            const roles = [...sourceGuild.roles.cache.values()].sort((a, b) => b.position - a.position);
            const roleMap = new Map();
            
            for (const role of roles) {
                if (role.managed || role.name === '@everyone') {
                    if (role.name === '@everyone') roleMap.set(role.id, targetGuild.roles.everyone.id);
                    continue;
                }
                const newRole = await targetGuild.roles.create({
                    name: role.name,
                    color: role.color,
                    hoist: role.hoist,
                    permissions: role.permissions.bitfield,
                    mentionable: role.mentionable,
                    position: role.position,
                    reason: 'Server clone'
                });
                roleMap.set(role.id, newRole.id);
            }

            const categories = sourceGuild.channels.cache.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
            const channelMap = new Map();
            
            for (const category of categories.values()) {
                const newCategory = await targetGuild.channels.create({
                    name: category.name,
                    type: 4,
                    position: category.position,
                    permissionOverwrites: category.permissionOverwrites.cache.map(perm => ({
                        id: roleMap.get(perm.id) || perm.id,
                        allow: perm.allow.bitfield,
                        deny: perm.deny.bitfield
                    }))
                });
                channelMap.set(category.id, newCategory.id);
            }

            const channels = sourceGuild.channels.cache.filter(c => c.type !== 4).sort((a, b) => a.position - b.position);
            
            for (const channel of channels.values()) {
                const parentId = channel.parentId ? channelMap.get(channel.parentId) : null;
                await targetGuild.channels.create({
                    name: channel.name,
                    type: channel.type,
                    topic: channel.topic,
                    nsfw: channel.nsfw,
                    bitrate: channel.bitrate,
                    userLimit: channel.userLimit,
                    rateLimitPerUser: channel.rateLimitPerUser,
                    position: channel.position,
                    parent: parentId,
                    permissionOverwrites: channel.permissionOverwrites.cache.map(perm => ({
                        id: roleMap.get(perm.id) || perm.id,
                        allow: perm.allow.bitfield,
                        deny: perm.deny.bitfield
                    }))
                });
            }
            
            return true;
        } catch (error) {
            console.error(error);
            return false;
        }
    }
};
