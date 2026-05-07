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

        const args = message.content.split(' ');
        const command = args[0].toLowerCase();

        if (command === '!puyo') {
            if (args.length < 2) {
                return message.reply('Usage: `!puyo <RoomCode>`');
            }
            const roomCode = args[1];
            await sendRoomInfo(message.channel, roomCode);
            return;
        }

        if (command === '!rooms') {
            await listRooms(message.channel);
            return;
        }

        if (command === '!rules') {
            await sendRules(message.channel);
            return;
        }

        if (command === '!settings') {
            if (args.length < 2) {
                return message.reply('Usage: `!settings <RoomCode>`');
            }
            await sendRoomSettings(message.channel, args[1]);
            return;
        }

        if (command === '!topp') {
            await sendTopScores(message.channel);
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
    
    const playerList = Array.from(room.playerStates.values()).map(p => {
         let icon = p.isBot ? '🤖' : '👤';
         let status = p.isSpectator ? '👁️ Spectator' : (p.ready ? '✅ Ready' : '⏳ Waiting');
         return `${icon} **${p.name}**: ${status}`;
    }).join('\n') || 'None';

    const baseUrl = process.env.BASE_URL || 'https://k2011.tail796c0a.ts.net'; 
    const gameUrl = `${baseUrl}?room=${roomCode}`;

    const embed = new EmbedBuilder()
        .setColor(0x00FF00) // Green for new
        .setTitle(`🎮 Puyo Puyo Room: ${roomCode}`)
        .setThumbnail("https://raw.githubusercontent.com/google/material-design-icons/master/png/action/videogame_asset/materialicons/48dp/1x/baseline_videogame_asset_black_48dp.png") // Generic game icon
        .setDescription(`**Status**: 🟢 Lobby Open\n\n**Players (${playerCount}/8)**:\n${playerList}`)
        .addFields({ name: 'Join the Battle!', value: `[Click here to play](${gameUrl})` })
        .setFooter({ text: "Type !puyo <RoomCode> to refresh this view." })
        .setTimestamp();

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('🎮 Play Now')
                .setStyle(ButtonStyle.Link)
                .setURL(gameUrl),
            new ButtonBuilder()
                .setCustomId(`join_${roomCode}`)
                .setLabel('🤝 Request Invite')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`notify_${roomCode}`)
                .setLabel('🔔 Notify End')
                .setStyle(ButtonStyle.Secondary)
        );

    const message = await channel.send({ embeds: [embed], components: [row] });
    roomMessages.set(roomCode, { channelId: channel.id, messageId: message.id });
}

async function listRooms(channel) {
    if (!serverDataReference || serverDataReference.rooms.size === 0) {
        return channel.send("No active rooms at the moment. Create one at the game site!");
    }

    const embed = new EmbedBuilder()
        .setColor(0x4A90E2)
        .setTitle("🏢 Active Puyo Puyo Rooms")
        .setTimestamp();

    let roomDesc = "";
    serverDataReference.rooms.forEach((room, code) => {
        const status = room.gameStarted ? "🔥 Playing" : "🟢 Lobby";
        const players = room.players.length;
        roomDesc += `\`${code}\` - **${status}** (${players} players)\n`;
    });

    embed.setDescription(roomDesc || "No rooms found.");
    channel.send({ embeds: [embed] });
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
             let icon = p.isBot ? '🤖' : '👤';
             let status = '';
             if (p.isSpectator) status = '👁️ Spectator';
             else if (!room.gameStarted) status = p.ready ? '✅ Ready' : '⏳ Waiting';
             else status = p.alive ? '❤️ Alive' : '💀 Dead';
             return `${icon} **${p.name}**: ${status}`;
        }).join('\n') || 'None';

        const statusText = room.gameStarted ? '🔥 In Progress' : '🟢 Waiting for Players';
        const color = room.gameStarted ? 0xFF5555 : 0x0099FF;

        const baseUrl = process.env.BASE_URL || 'https://k2011.tail796c0a.ts.net'; 
        const gameUrl = `${baseUrl}?room=${roomCode}`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`🎮 Puyo Puyo Room: ${roomCode}`)
            .setThumbnail("https://raw.githubusercontent.com/google/material-design-icons/master/png/action/videogame_asset/materialicons/48dp/1x/baseline_videogame_asset_black_48dp.png")
            .setDescription(`**Status**: ${statusText}\n\n**Players (${playerCount}/8)**:\n${playerList}`)
            .addFields({ name: 'Join the Battle!', value: `[Click here to play](${gameUrl})` })
            .setFooter({ text: "Type !puyo <RoomCode> to refresh this view." })
            .setTimestamp();
            
         const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setLabel('🎮 Play Now')
                    .setStyle(ButtonStyle.Link)
                    .setURL(gameUrl),
                new ButtonBuilder()
                    .setCustomId(`join_${roomCode}`)
                    .setLabel('🤝 Request Invite')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`notify_${roomCode}`)
                    .setLabel('🔔 Notify End')
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

async function notifyRoomCreated(roomCode) {
    // Find the first channel the bot is in to announce
    if (!client) return;
    const guild = client.guilds.cache.first();
    if (!guild) return;
    const channel = guild.channels.cache.find(c => c.name === 'puyo-updates' || (c.type === 0 && c.permissionsFor(guild.members.me).has('SendMessages')));
    
    if (channel) {
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle("🆕 New Room Created!")
            .setDescription(`A new game room \`${roomCode}\` is now open.\nType \`!puyo ${roomCode}\` to see details or join!`)
            .setTimestamp();
        channel.send({ embeds: [embed] });
    }
}

async function notifyGameStart(roomCode) {
    if (!roomMessages.has(roomCode)) return;
    const { channelId } = roomMessages.get(roomCode);
    
    const channel = await client.channels.fetch(channelId);
    if (channel) {
        channel.send(`🚀 **Game Started in Room ${roomCode}!** Let the battle begin!`);
    }
}

async function sendRules(channel) {
    const embed = new EmbedBuilder()
        .setColor(0x00D9FF)
        .setTitle("📖 Puyo Puyo Rules & Controls")
        .setDescription("Learn how to play and dominate the field!")
        .addFields(
            { name: "⌨️ Keyboard Controls", value: "• **Arrow Keys / WASD**: Move & Rotate\n• **Space / Up**: Rotation\n• **Shift / Down**: Hard Drop" },
            { name: "📱 Touch Controls", value: "• **Tap**: Rotate\n• **Swipe Left/Right**: Move\n• **Swipe Down**: Soft Drop\n• **Diagonal Down Swipe**: Hard Drop" },
            { name: "💡 Basics", value: "• Match 4 or more puyos of the same color to clear them.\n• Chain clears to send garbage to your opponents!\n• If your center column fills to the top, you lose." }
        )
        .setFooter({ text: "Happy Puyo-ing!" });
    
    await channel.send({ embeds: [embed] });
}

async function sendRoomSettings(channel, roomCode) {
    if (!serverDataReference || !serverDataReference.rooms.has(roomCode)) {
        return channel.send(`Room \`${roomCode}\` not found.`);
    }

    const room = serverDataReference.rooms.get(roomCode);
    const settings = room.settings;

    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`⚙️ Settings for Room: ${roomCode}`)
        .addFields(
            { name: "Garbage Rate", value: `${settings.garbageRate}`, inline: true },
            { name: "Drop Speed", value: `${settings.dropSpeed}ms`, inline: true },
            { name: "Defeat Time", value: `${settings.defeatTime}s`, inline: true },
            { name: "Garbage Delay", value: `${settings.garbageDelay}s`, inline: true }
        )
        .setTimestamp();

    await channel.send({ embeds: [embed] });
}

async function sendTopScores(channel) {
    if (!serverDataReference) return;

    // We'll need to gather high scores from active rooms as a simple implementation
    let allScores = [];
    serverDataReference.rooms.forEach(room => {
        room.playerStates.forEach(state => {
            allScores.push({ name: state.name, score: state.score });
        });
    });

    allScores.sort((a, b) => b.score - a.score);
    const top5 = allScores.slice(0, 5);

    const embed = new EmbedBuilder()
        .setColor(0xFF8C00)
        .setTitle("🏆 Session High Scores (Top 5)")
        .setDescription(top5.length > 0 ? 
            top5.map((s, i) => `${i + 1}. **${s.name}**: ${s.score} pts`).join('\n') : 
            "No scores recorded yet in this session.")
        .setTimestamp();

    await channel.send({ embeds: [embed] });
}

module.exports = { startBot, notifyGameEnd, updateRoomInfo, onRoomClosed, sendChatMessage, notifyRoomCreated, notifyGameStart };
