// Discord Bot for Thread Recreation on Checkmark
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
require('dotenv').config();

// Create client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // For accessing thread members
  ],
  partials: [
    Partials.Message,
    Partials.Reaction,
    Partials.Channel,
    Partials.ThreadMember,
  ],
});

// Configuration
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const COMPLETION_CHANNEL_ID = process.env.COMPLETION_CHANNEL_ID || "completed-tasks";
const CHECKMARK_EMOJIS = ['✅', '✓', '☑️', '🗸', '☑', '✔️', '✔'];

// When the client is ready
client.once('ready', () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
  console.log(`Monitoring for checkmark reactions in channel: ${TARGET_CHANNEL_ID}`);
  console.log(`Recreating threads in channel: ${COMPLETION_CHANNEL_ID}`);

  // Check if completion channel exists and create it if needed
  client.guilds.cache.forEach(async (guild) => {
    if (isNaN(COMPLETION_CHANNEL_ID)) {
      const existingChannel = guild.channels.cache.find(
        channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0
      );
      if (!existingChannel) {
        try {
          const newChannel = await guild.channels.create({
            name: COMPLETION_CHANNEL_ID,
            type: 0, // GUILD_TEXT
            topic: 'Automatically archived completed tasks and threads',
          });
          console.log(`Created new completion channel: ${newChannel.name} (${newChannel.id})`);
        } catch (error) {
          console.error(`Failed to create completion channel: ${error}`);
        }
      }
    }
  });
});

// Function to recreate a thread with its contents
async function recreateThread(message, user) {
  try {
    // Get the target channel for the recreated thread
    let completionChannel;
    try {
      completionChannel = await client.channels.fetch(COMPLETION_CHANNEL_ID);
    } catch (err) {
      completionChannel = message.guild.channels.cache.find(
        channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0
      );
      if (!completionChannel) {
        console.error(`Could not find completion channel with ID or name: ${COMPLETION_CHANNEL_ID}`);
        return;
      }
    }

    let originalThread;
    let threadParentMessage;

    // Check if the message is part of a thread or is a thread starter
    if (message.channel.isThread()) {
      originalThread = message.channel;
      try {
        threadParentMessage = await originalThread.fetchStarterMessage();
      } catch (err) {
        console.log('Could not fetch thread starter message:', err);
      }
    } else if (message.thread) {
      originalThread = message.thread;
      threadParentMessage = message;
    } else {
      console.log('Message is not part of a thread. Creating standard completion notification instead.');
      await createCompletionNotification(message, user);
      return;
    }

    await originalThread.fetch();

    const threadName = originalThread.name || "Completed Thread";

    let threadStarter = `## Thread Completed ✅
**Original Thread:** ${threadName}
**Marked complete by:** ${user.tag}
**Completed at:** ${new Date().toLocaleString()}
**Original Thread Link:** https://discord.com/channels/${message.guild.id}/${originalThread.id}
`;

    if (threadParentMessage) {
      threadStarter += `\n**Thread Started By:** ${threadParentMessage.author.tag}
**Thread Start Message:** ${threadParentMessage.content ? threadParentMessage.content.substring(0, 200) : "(No content)"}${threadParentMessage.content && threadParentMessage.content.length > 200 ? "..." : ""}
`;
    }

    threadStarter += "\n--- Thread Contents Below ---";

    const newThread = await completionChannel.threads.create({
      name: `✅ ${threadName}`,
      message: {
        content: threadStarter,
      },
      autoArchiveDuration: 10080, // 1 week
    });

    console.log(`Created new thread: ${newThread.name} (${newThread.id})`);

    const originalMessages = await originalThread.messages.fetch({ limit: 100 });
    const sortedMessages = Array.from(originalMessages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (originalMessages.size >= 100) {
      await newThread.send('⚠️ **Note:** This thread had more than 100 messages. Only the most recent 100 messages are shown here due to Discord API limitations.');
    }

    for (const originalMessage of sortedMessages) {
      if (originalMessage.system) continue;

      let messageContent = `**${originalMessage.author.tag}** (${new Date(originalMessage.createdTimestamp).toLocaleString()}):\n`;
      if (originalMessage.content) {
        messageContent += originalMessage.content;
      }
      if (originalMessage.embeds && originalMessage.embeds.length > 0) {
        messageContent += "\n[Message contained embeds]";
      }
      if (originalMessage.attachments && originalMessage.attachments.size > 0) {
        messageContent += "\n**Attachments:**\n";
        originalMessage.attachments.forEach(attachment => {
          messageContent += `- ${attachment.name}: ${attachment.url}\n`;
        });
      }
      if (messageContent.length > 1900) {
        const chunks = splitTextIntoChunks(messageContent, 1900);
        for (const chunk of chunks) {
          await newThread.send(chunk);
        }
      } else {
        await newThread.send(messageContent);
      }
    }

    await newThread.send('--- End of Thread Content ---');

    // Mark the original message with a special reaction to show it was processed
    await message.react('📋');

    const archiveEmbed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Thread Archived')
    .setDescription(
      `A copy of this thread has been created ${newThread.id}).`
    );


  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('🔄 Reopen')
      .setCustomId(`reopen_${completionThread.id}_${completionMsg.id}`)
      .setStyle(ButtonStyle.Primary)
  );
    // send embed + buttons
    const sentMessage = await originalThread.send({
      embeds: [archiveEmbed],
      components: [row],
    });

    // NEW: Post a summary message in the completed-tasks channel
    await postCompletionSummary(message, user, originalThread, newThread, completionChannel);

    return newThread;

  } catch (error) {
    console.error('Error recreating thread:', error);
  }
}

// NEW FUNCTION: Post a summary of the completed task in the completed-tasks channel
async function postCompletionSummary(message, user, originalThread, newThread, completionChannel) {
  try {
    const targetChannel = completionChannel;
    if (!targetChannel) {
      console.error('Could not find target channel for summary message');
      return;
    }

    const memberCount = originalThread.memberCount || 'Unknown';
    const messages = await originalThread.messages.fetch({ limit: 100 });
    const sortedMessages = Array.from(messages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const firstMessage = sortedMessages[0];
    const lastMessage = sortedMessages[sortedMessages.length - 1];

    let threadDuration = 'Unknown';
    if (firstMessage && lastMessage) {
      const durationMs = lastMessage.createdTimestamp - firstMessage.createdTimestamp;
      if (durationMs < 60000) {
        threadDuration = `${Math.round(durationMs / 1000)} seconds`;
      } else if (durationMs < 3600000) {
        threadDuration = `${Math.round(durationMs / 60000)} minutes`;
      } else if (durationMs < 86400000) {
        threadDuration = `${Math.round(durationMs / 3600000)} hours`;
      } else {
        threadDuration = `${Math.round(durationMs / 86400000)} days`;
      }
    }

    const participants = new Set();
    sortedMessages.forEach(msg => {
      if (msg.author && !msg.author.bot) {
        participants.add(msg.author.id);
      }
    });

    let keywords = 'N/A';
    if (originalThread.name) {
      const extractedKeywords = originalThread.name
        .split(/[\s,.-_]+/)
        .filter(word => word.length > 3)
        .slice(0, 5);
      if (extractedKeywords.length > 0) {
        keywords = extractedKeywords.join(', ');
      }
    }

    const summaryEmbed = {
      color: 0x00FF00,
      title: `✅ Task Completed: ${originalThread.name}`,
      description: `This task has been marked as completed by ${user.toString()} and archived.`,
      fields: [
        {
          name: '📊 Thread Stats',
          value: `• **Duration:** ${threadDuration}\n• **Messages:** ${sortedMessages.length}\n• **Participants:** ${participants.size}\n• **Topics:** ${keywords}`
        },
        {
          name: '🔗 Links',
          value: `• [Original Thread](https://discord.com/channels/${message.guild.id}/${originalThread.id})\n• [Archive Copy](https://discord.com/channels/${message.guild.id}/${newThread.id})`
        }
      ],
      timestamp: new Date(),
      footer: {
        text: `Task ID: ${originalThread.id.slice(-6)}`
      }
    };

    await targetChannel.send({ embeds: [summaryEmbed] });
    console.log(`Posted completion summary in channel: ${targetChannel.id}`);

  } catch (error) {
    console.error('Error posting completion summary:', error);
  }
}

// Function to create a regular completion notification for non-thread messages
async function createCompletionNotification(message, user) {
  try {
    let completionChannel;
    try {
      completionChannel = await client.channels.fetch(COMPLETION_CHANNEL_ID);
    } catch (err) {
      completionChannel = message.guild.channels.cache.find(
        channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0
      );
      if (!completionChannel) {
        console.error(`Could not find completion channel with ID or name: ${COMPLETION_CHANNEL_ID}`);
        return;
      }
    }

    let contentToDisplay = "No content";
    if (message.content && typeof message.content === 'string') {
      contentToDisplay = message.content.trim();
      if (contentToDisplay.length === 0) {
        contentToDisplay = "(Empty message)";
      } else if (contentToDisplay.length > 1000) {
        contentToDisplay = `${contentToDisplay.substring(0, 1000)}...`;
      }
    } else if (message.embeds && message.embeds.length > 0) {
      contentToDisplay = "(Message contained embeds)";
    } else if (message.attachments && message.attachments.size > 0) {
      contentToDisplay = "(Message contained attachments)";
    }

    const formattedDate = new Date().toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const completionMessage = `
## Task Completed ✅
**Task:** ${contentToDisplay}
**Originally posted by:** ${message.author ? message.author.tag : "Unknown User"}
**Marked complete by:** ${user.tag}
**Completed at:** ${formattedDate}
**Original Message Link:** https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}
`;

    const archiveMessage = await completionChannel.send(completionMessage);
    console.log(`Completion message posted to channel: ${COMPLETION_CHANNEL_ID}`);

    await message.react('📋');

    const summaryEmbed = {
      color: 0x00FF00,
      title: `✅ Task Completed`,
      description: `This task has been marked as completed by ${user.toString()} and archived.`,
      fields: [
        {
          name: '📝 Task Details',
          value: `${contentToDisplay.length > 200 ? contentToDisplay.substring(0, 200) + "..." : contentToDisplay}`
        },
        {
          name: '🔗 Links',
          value: `• [Original Message](https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id})\n• [Archive Copy](https://discord.com/channels/${message.guild.id}/${archiveMessage.channel.id}/${archiveMessage.id})`
        }
      ],
      timestamp: new Date(),
      footer: {
        text: `Task ID: ${message.id.slice(-6)}`
      }
    };

    await completionChannel.send({ embeds: [summaryEmbed] });
  } catch (error) {
    console.error('Error creating completion notification:', error);
  }
}

// Helper function to split long text into chunks
function splitTextIntoChunks(text, maxLength) {
  const chunks = [];
  let currentChunk = '';

  const lines = text.split('\n');
  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        console.error('Something went wrong when fetching the reaction:', error);
        return;
      }
    }

    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (error) {
        console.error('Something went wrong when fetching the message:', error);
        return;
      }
    }

    let relevantChannelId;
    if (reaction.message.channel.isThread()) {
      const parentChannel = reaction.message.channel.parent;
      if (parentChannel) {
        relevantChannelId = parentChannel.id;
      }
    } else {
      relevantChannelId = reaction.message.channel.id;
    }

    const isInTargetChannel = relevantChannelId === TARGET_CHANNEL_ID;
    const isInTargetThread = reaction.message.channel.isThread() &&
                             reaction.message.channel.parentId === TARGET_CHANNEL_ID;

    if ((isInTargetChannel || isInTargetThread) && CHECKMARK_EMOJIS.includes(reaction.emoji.name)) {
      console.log(`Checkmark (${reaction.emoji.name}) detected from ${user.tag} in ${reaction.message.channel.isThread() ? 'thread' : 'channel'}`);

      if (reaction.message.reactions.cache.some(r =>
        r.emoji.name === '📋' &&
        r.users.cache.has(client.user.id))) {
        console.log('This message was already marked as completed. Skipping.');
        return;
      }

      await recreateThread(reaction.message, user);
    }
  } catch (error) {
    console.error('Error processing reaction:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // only handle our reopen_* buttons
  if (!interaction.customId.startsWith('reopen_')) return;

  // parse out the two IDs
  // format is: reopen_<completionThreadId>_<completionMsgId>
  const [, completionThreadId, completionMsgId] = interaction.customId.split('_');

  // 1️⃣ delete the embed in the original thread
  await interaction.message.delete();

  // 2️⃣ fetch & delete the embed in completed-tasks
  const completionThread = await interaction.guild.channels.fetch(completionThreadId);
  if (completionThread && completionThread.isThread()) {
    // delete the embed message
    await completionThread.messages.delete(completionMsgId).catch(() => null);
    // delete the thread itself
    await completionThread.delete('Reopening original thread').catch(() => null);
  }

  // 3️⃣ reopen the original thread
  const originalThread = interaction.channel;
  if (originalThread.isThread()) {
    await originalThread.setLocked(false, 'Reopened');
    await originalThread.setArchived(false, 'Reopened');
  }

  // final ack
  await interaction.reply({
    content: 'Thread reopened and archived copy removed.',
    ephemeral: true
  });
});


client.login(process.env.DISCORD_TOKEN);
