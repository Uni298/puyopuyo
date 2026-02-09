const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
require('dotenv').config();

let client;
let serverDataReference = null; // Reference to server's room data
let roomMessages = new Map(); // roomCode -> { channelId, messageId }
let notifySubscribers = new Map(); // roomCode -> Set<userId>

// Initialize Bot
function startBot(token, serverData) {
    if (!token) {
        console.warn("Discord Bot Token not provided. Bot will not start.");
        return;
    }

    serverDataReference = serverData;

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    client.once(Events.ClientReady, c => {
        console.log(`Ready! Logged in as ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot) return;

        if (message.content.startsWith('!puyo')) {
            const args = message.content.split(' ');
            if (args.length < 2) {
                return message.reply('Usage: `!puyo <RoomCode>`');
            }

            const roomCode = args[1];
            await sendRoomInfo(message.channel, roomCode);
            return;
        }

        // Chat Sync: Discord -> Game
        for (const [code, info] of roomMessages.entries()) {
            if (info.channelId === message.channel.id) {
                if (serverDataReference && typeof serverDataReference.broadcastChat === 'function') {
                     serverDataReference.broadcastChat(code, message.author.username, message.content);
                }
                break;
            }
        }
    });

    client.on(Events.InteractionCreate, async interaction => {
        if (!interaction.isButton()) return;

        const [action, roomCode] = interaction.customId.split('_');

        if (action === 'join') {
            // Join Request
            await handleJoinRequest(interaction, roomCode);
        } else if (action === 'notify') {
            // Notify End Subscription
            await handleNotifySubscription(interaction, roomCode);
        }
    });

    client.login(token).catch(err => {
        console.error("Failed to login to Discord:", err);
    });
}

async function sendRoomInfo(channel, roomCode) {
    if (!serverDataReference || !serverDataReference.rooms.has(roomCode)) {
        return channel.send(`Room ${roomCode} not found.`);
    }

    const room = serverDataReference.rooms.get(roomCode);
    const playerCount = room.players.length;
    // Initial List
    const playerList = Array.from(room.playerStates.values()).map(p => {
         return `**${p.name}**: ${p.isSpectator ? '👁️ Spectator' : (p.ready ? '✅ Ready' : '⏳ Waiting')}`;
    }).join('\n') || 'None';

    const baseUrl = process.env.BASE_URL || 'http://localhost:3000'; 
    const gameUrl = `${baseUrl}?room=${roomCode}`;

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`Puyo Puyo Battle Royale - Room ${roomCode}`)
        .setDescription(`**Status**: 🟢 Waiting for Players\n\n**Players (${playerCount})**:\n${playerList}`)
        .addFields({ name: 'Join Link', value: gameUrl });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('Go to Game Page')
                .setStyle(ButtonStyle.Link)
                .setURL(gameUrl),
            new ButtonBuilder()
                .setCustomId(`join_${roomCode}`)
                .setLabel('Request to Join')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`notify_${roomCode}`)
                .setLabel('Notify on End')
                .setStyle(ButtonStyle.Secondary)
        );

    const message = await channel.send({ embeds: [embed], components: [row] });
    roomMessages.set(roomCode, { channelId: channel.id, messageId: message.id });
}

async function updateRoomInfo(roomCode) {
    if (!serverDataReference || !roomMessages.has(roomCode)) return;
    const { channelId, messageId } = roomMessages.get(roomCode);
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        const message = await channel.messages.fetch(messageId);
        if (!message) return;
        
        const room = serverDataReference.rooms.get(roomCode);
        if (!room) {
             const embed = new EmbedBuilder()
                .setColor(0x999999)
                .setTitle(`Puyo Puyo - Room ${roomCode} (Closed)`)
                .setDescription("This room has closed.");
             await message.edit({ embeds: [embed], components: [] });
             roomMessages.delete(roomCode);
             return;
        }

        const playerCount = room.players.length;
        const playerList = Array.from(room.playerStates.values()).map(p => {
             let status = '';
             if (p.isSpectator) status = '👁️ Spectator';
             else if (!room.gameStarted) status = p.ready ? '✅ Ready' : '⏳ Waiting';
             else status = p.alive ? '❤️ Alive' : '💀 Dead';
             return `**${p.name}**: ${status}`;
        }).join('\n') || 'None';

        const statusText = room.gameStarted ? '🔥 In Progress' : '🟢 Waiting for Players';
        const color = room.gameStarted ? 0xFF5555 : 0x0099FF;

        const baseUrl = process.env.BASE_URL || 'http://localhost:3000'; 
        const gameUrl = `${baseUrl}?room=${roomCode}`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`Puyo Puyo Battle Royale - Room ${roomCode}`)
            .setDescription(`**Status**: ${statusText}\n\n**Players (${playerCount})**:\n${playerList}`)
            .addFields({ name: 'Join Link', value: gameUrl });
            
         const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setLabel('Go to Game Page')
                    .setStyle(ButtonStyle.Link)
                    .setURL(gameUrl),
                new ButtonBuilder()
                    .setCustomId(`join_${roomCode}`)
                    .setLabel('Request to Join')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`notify_${roomCode}`)
                    .setLabel('Notify on End')
                    .setStyle(ButtonStyle.Secondary)
            );

        await message.edit({ embeds: [embed], components: [row] });
    } catch (e) {
        console.error(`Failed to update room info for ${roomCode}:`, e);
    }
}

async function handleJoinRequest(interaction, roomCode) {
    if (!serverDataReference || !serverDataReference.rooms.has(roomCode)) {
        return interaction.reply({ content: 'Room no longer exists.', ephemeral: true });
    }

    const room = serverDataReference.rooms.get(roomCode);
    
    // Send notification to game server
    const user = interaction.user;
    const discordName = user.username; // or globalName

    // We need a way to broadcast to the room.
    // We can assume serverDataReference has a broadcast function or we access room.players.
    room.players.forEach(player => {
        if (player.readyState === 1) { // WebSocket.OPEN
            player.send(JSON.stringify({
                type: 'discord_join_request',
                discordName: discordName
            }));
        }
    });

    await interaction.reply({ content: `Join request sent to Room ${roomCode}!`, ephemeral: true });
}

async function handleNotifySubscription(interaction, roomCode) {
    if (!notifySubscribers.has(roomCode)) {
        notifySubscribers.set(roomCode, new Set());
    }
    notifySubscribers.get(roomCode).add(interaction.user.id);
    
    await interaction.reply({ content: 'You will be notified when this game ends.', ephemeral: true });
}

function notifyGameEnd(roomCode, winnerName) {
    if (notifySubscribers.has(roomCode)) {
        const userIds = notifySubscribers.get(roomCode);
        userIds.forEach(userId => {
            client.users.fetch(userId).then(user => {
                user.send(`Game in Room ${roomCode} has ended! Winner: ${winnerName}`);
            }).catch(console.error);
        });
        notifySubscribers.delete(roomCode);
    }
}

async function onRoomClosed(roomCode) {
    if (!roomMessages.has(roomCode)) return;
    const { channelId, messageId } = roomMessages.get(roomCode);
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        const message = await channel.messages.fetch(messageId);
        if (!message) return;

        const embed = new EmbedBuilder()
            .setColor(0x808080) // Grey
            .setTitle(`Puyo Puyo - Room ${roomCode} (Closed)`)
            .setDescription("❌ This room has ended and is now closed.");
            
        await message.edit({ embeds: [embed], components: [] }); // Remove buttons
        roomMessages.delete(roomCode);
    } catch (e) {
        console.error(`Failed to close room info for ${roomCode}:`, e);
    }
}

async function sendChatMessage(roomCode, sender, content) {
    if (!roomMessages.has(roomCode)) return;
    const { channelId } = roomMessages.get(roomCode);
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;
        
        await channel.send(`**[Game] ${sender}**: ${content}`);
    } catch (e) {
        console.error(`Failed to send chat to Discord for ${roomCode}:`, e);
    }
}

module.exports = { startBot, notifyGameEnd, updateRoomInfo, onRoomClosed, sendChatMessage };
