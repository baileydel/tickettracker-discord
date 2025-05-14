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
}// Discord Bot for Thread Recreation on Checkmark
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

    const archiveEmbeds = new EmbedBuilder()
      .setColor(0x22B14C)  // Green color to match screenshot
      .setTitle(`✅ Task Completed: ${threadName}`)
      .setDescription(
        `This task has been marked as completed by ${user.toString()} and archived.`
      )
      .addFields(
        {
          name: '📊 Thread Stats',
          value: `• **Duration:** ${await getThreadDuration(originalThread)}\n• **Messages:** ${await getMessageCount(originalThread)}\n• **Participants:** ${await getParticipantCount(originalThread)}\n• **Topics:** ${extractKeywords(threadName)}`
        },
        {
          name: '🔗 Links',
          value: `• [Original Thread](https://discord.com/channels/${message.guild.id}/${originalThread.id})\n• [Archive Copy](https://discord.com/channels/${message.guild.id}/${originalThread.id})`
        }
      )
      .setFooter({ text: `Task ID: ${originalThread.id.slice(-6)} • Today at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` });

    // Create a button with the thread IDs and message ID stored for reopening
    const rows = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('🔄 Original Issue Thread')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${message.guild.id}/${originalThread.id}`)
    );

    // IMPROVED THREAD CREATION: Create a message first, then start a thread from it
    // This allows us to delete the message later if needed
    const starterMessage = await completionChannel.send({
        embeds: [archiveEmbeds],
        components: [rows]
    });

    // Store the starter message ID for later deletion
    const starterMessageId = starterMessage.id;

    // Now create the thread from this message
    const newThread = await starterMessage.startThread({
      name: `✅ ${threadName}`,
      autoArchiveDuration: 10080 // 1 week
    });

    rows.addComponents(
        new ButtonBuilder()
        .setLabel('🔄 Reopen')
        .setCustomId(`reopen_${newThread.id}_${starterMessageId}`)
        .setStyle(ButtonStyle.Primary)
    );
  
    // Update the embed with the correct archive copy link now that we have the thread ID
    archiveEmbeds.setFields(
      {
        name: '📊 Thread Stats',
        value: `• **Duration:** ${await getThreadDuration(originalThread)}\n• **Messages:** ${await getMessageCount(originalThread)}\n• **Participants:** ${await getParticipantCount(originalThread)}\n• **Topics:** ${extractKeywords(threadName)}`
      },
      {
        name: '🔗 Links',
        value: `• [Original Thread](https://discord.com/channels/${message.guild.id}/${originalThread.id})\n• [Archive Copy](https://discord.com/channels/${message.guild.id}/${newThread.id})`
      }
    );
  
    await starterMessage.edit({
        embeds: [archiveEmbeds],
        components: [rows]
    });

    console.log(`Created new thread: ${newThread.name} (${newThread.id}) with parent message: ${starterMessageId}`);

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
      
    // We'll no longer send additional embeds or summary messages
    const summaryMessageId = null;

    return { 
      thread: newThread, 
      starterMessageId: starterMessageId
    };

  } catch (error) {
    console.error('Error recreating thread:', error);
    return null;
  }
}

// Note: We've removed the postCompletionSummary function as it's no longer needed

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

// Helper functions for thread statistics
async function getThreadDuration(thread) {
  try {
    const messages = await thread.messages.fetch({ limit: 100 });
    const sortedMessages = Array.from(messages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    
    if (sortedMessages.length < 2) return "0 seconds";
    
    const firstMessage = sortedMessages[0];
    const lastMessage = sortedMessages[sortedMessages.length - 1];
    
    const durationMs = lastMessage.createdTimestamp - firstMessage.createdTimestamp;
    if (durationMs < 60000) {
      return `${Math.round(durationMs / 1000)} seconds`;
    } else if (durationMs < 3600000) {
      return `${Math.round(durationMs / 60000)} minutes`;
    } else if (durationMs < 86400000) {
      return `${Math.round(durationMs / 3600000)} hours`;
    } else {
      return `${Math.round(durationMs / 86400000)} days`;
    }
  } catch (error) {
    console.error('Error calculating thread duration:', error);
    return "Unknown";
  }
}

async function getMessageCount(thread) {
  try {
    const messages = await thread.messages.fetch({ limit: 100 });
    return messages.size;
  } catch (error) {
    console.error('Error counting messages:', error);
    return 0;
  }
}

async function getParticipantCount(thread) {
  try {
    const messages = await thread.messages.fetch({ limit: 100 });
    const participants = new Set();
    
    messages.forEach(msg => {
      if (msg.author && !msg.author.bot) {
        participants.add(msg.author.id);
      }
    });
    
    return participants.size;
  } catch (error) {
    console.error('Error counting participants:', error);
    return 0;
  }
}

function extractKeywords(threadName) {
  if (!threadName) return "N/A";
  
  const keywords = threadName
    .split(/[\s,.-_]+/)
    .filter(word => word.length > 3)
    .slice(0, 5);
    
  return keywords.length > 0 ? keywords.join(', ') : threadName;
}

// COMPLETELY REWRITTEN REACTION HANDLER
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

      reaction.message.delete().catch(error => {
        console.error('Failed to delete original message:', error);
      });

    }
  } catch (error) {
    console.error('Error processing reaction:', error);
  }
});

// COMPLETELY REWRITTEN INTERACTION HANDLER
// COMPLETELY REWRITTEN INTERACTION HANDLER
client.on('interactionCreate', async (interaction) => {
  // Handle reopen button clicks
  if (interaction.isButton() && interaction.customId.startsWith('reopen_')) {
    try {
      // Acknowledge the interaction immediately
      await interaction.deferReply({ ephemeral: true });

      // Parse out the IDs - format is: reopen_<archiveThreadId>_<starterMessageId>
      const [, archiveThreadId, starterMessageId] = interaction.customId.split('_');
      
      console.log(`Processing reopen for archive thread: ${archiveThreadId}, starter message: ${starterMessageId}`);

      // Need to find the original thread ID before deleting messages
      let originalThreadId;
      
      // Get the completion channel
      let completionChannel;
      try {
        if (isNaN(COMPLETION_CHANNEL_ID)) {
          completionChannel = interaction.guild.channels.cache.find(
            channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0
          );
        } else {
          completionChannel = await interaction.guild.channels.fetch(COMPLETION_CHANNEL_ID);
        }
      } catch (err) {
        console.error('Failed to get completion channel:', err);
      }
      
      // Extract the original thread ID from the embed before deletion
      if (interaction.message && interaction.message.embeds && interaction.message.embeds.length > 0) {
        const embed = interaction.message.embeds[0];
        if (embed.fields) {
          const linksField = embed.fields.find(field => field.name === '🔗 Links');
          if (linksField && linksField.value) {
            // Extract the original thread ID from the link
            const originalThreadMatch = linksField.value.match(/channels\/\d+\/(\d+)/);
            if (originalThreadMatch && originalThreadMatch[1]) {
              originalThreadId = originalThreadMatch[1];
              console.log(`Found original thread ID: ${originalThreadId}`);
            }
          }
        }
      }
      
      // Get the title of the completed task for the reopen notification
      let taskTitle = "Unknown Task";
      if (interaction.message && interaction.message.embeds && interaction.message.embeds.length > 0) {
        const embed = interaction.message.embeds[0];
        if (embed.title && embed.title.startsWith('✅ Task Completed:')) {
          taskTitle = embed.title.replace('✅ Task Completed:', '').trim();
        }
      }

      // 1️⃣ Delete the button message in the original thread
      await interaction.message.delete().catch(error => {
        console.error('Failed to delete button message:', error);
      });

      // 2️⃣ Find and delete all related messages in the completion channel
      if (completionChannel) {
        try {
          // First, try to find the summary message by task ID in the footer
          const recentMessages = await completionChannel.messages.fetch({ limit: 50 });
          
          // Find summary embed messages
          for (const [id, msg] of recentMessages.entries()) {
            // Look for messages with embeds that might be our summary
            if (msg.embeds && msg.embeds.length > 0) {
              for (const embed of msg.embeds) {
                // Check if this embed mentions our thread ID
                if (embed.footer && embed.footer.text && embed.footer.text.includes(interaction.channel.id.slice(-6))) {
                  console.log(`Found and deleting summary message: ${msg.id}`);
                  await msg.delete().catch(err => console.error('Error deleting summary message:', err));
                  break;
                }
                
                // Also check in the fields for our thread ID
                if (embed.fields) {
                  for (const field of embed.fields) {
                    if (field.value && (field.value.includes(interaction.channel.id) || 
                                       field.value.includes(archiveThreadId))) {
                      console.log(`Found and deleting summary message by field match: ${msg.id}`);
                      await msg.delete().catch(err => console.error('Error deleting summary message:', err));
                      break;
                    }
                  }
                }
              }
            }
            
            // Also look for direct messages containing our thread ID in the text
            if (msg.content && msg.content.includes(interaction.channel.id)) {
              console.log(`Found and deleting related message by content: ${msg.id}`);
              await msg.delete().catch(err => console.error('Error deleting related message:', err));
            }
          }
          
          // Try to delete the starter message directly
          if (starterMessageId) {
            try {
              await completionChannel.messages.delete(starterMessageId);
              console.log(`Deleted starter message: ${starterMessageId}`);
            } catch (err) {
              console.log(`Could not delete starter message: ${starterMessageId}`);
            }
          }
          
          // Additional check for "Thread Completed" messages without embeds
          const threadCompletedMessages = recentMessages.filter(msg => 
            msg.content && 
            msg.content.includes("Thread Completed") && 
            msg.content.includes(interaction.channel.name)
          );
          
          for (const [id, msg] of threadCompletedMessages) {
            console.log(`Found and deleting thread completed message: ${msg.id}`);
            await msg.delete().catch(err => console.error('Error deleting thread completed message:', err));
          }
        } catch (err) {
          console.error('Error cleaning up completion channel messages:', err);
        }
      }

      // 3️⃣ Handle the archived thread cleanup
      try {
        // Only delete the archive thread itself, no summary messages to worry about anymore
        const archiveThread = await interaction.guild.channels.fetch(archiveThreadId).catch(() => null);
        
        if (archiveThread && archiveThread.isThread()) {
          // Delete the thread
          await archiveThread.delete('Thread reopened by user');
          console.log(`Deleted archive thread: ${archiveThreadId}`);
        } else {
          console.log(`Could not find archive thread: ${archiveThreadId}`);
        }
        
        // Delete the starter message if we have its ID
        if (starterMessageId && completionChannel) {
          try {
            await completionChannel.messages.delete(starterMessageId);
            console.log(`Deleted starter message: ${starterMessageId}`);
          } catch (err) {
            console.log(`Could not delete starter message: ${starterMessageId}`);
          }
        }
      } catch (err) {
        console.error('Error cleaning up archived content:', err);
      }
      
      // 4️⃣ NEW FEATURE: Send a reopen notification to the parent channel of the thread
      if (originalThreadId) {
        try {
          const originalThread = await interaction.guild.channels.fetch(originalThreadId).catch(() => null);
          
          if (originalThread && originalThread.isThread()) {
            // Get the parent channel of the thread
            const parentChannel = originalThread.parent;
            
            if (parentChannel) {
              const reopenEmbed = new EmbedBuilder()
                .setColor(0x3498DB) // Blue color
                .setTitle(`🔄 Task Reopened: ${taskTitle}`)
                .setDescription(`This task has been reopened by ${interaction.user.toString()}.`)
                .addFields({
                  name: 'Thread',
                  value: `<#${originalThread.id}>`
                })
                .setTimestamp()
                .setFooter({ 
                  text: `Task ID: ${originalThread.id.slice(-6)} • Today at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` 
                });
                
              // Create action row with buttons
              const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setLabel('🔗 Go to Thread')
                  .setStyle(ButtonStyle.Link)
                  .setURL(`https://discord.com/channels/${interaction.guild.id}/${originalThread.id}`),
                new ButtonBuilder()
                  .setLabel('✅ Close Task')
                  .setCustomId(`close_task_${originalThread.id}`)
                  .setStyle(ButtonStyle.Danger)
              );
                
              await parentChannel.send({ 
                embeds: [reopenEmbed],
                components: [actionRow]
              });
              console.log(`Sent reopen notification to parent channel: ${parentChannel.id}`);
            } else {
              console.log(`Could not find parent channel for thread: ${originalThreadId}`);
              
              // Fallback to target channel
              const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
              if (targetChannel) {
                const reopenEmbed = new EmbedBuilder()
                  .setColor(0x3498DB) // Blue color
                  .setTitle(`🔄 Task Reopened: ${taskTitle}`)
                  .setDescription(`This task has been reopened by ${interaction.user.toString()}.`)
                  .addFields({
                    name: 'Thread',
                    value: `<#${originalThread.id}>`
                  })
                  .setTimestamp()
                  .setFooter({ 
                    text: `Task ID: ${originalThread.id.slice(-6)} • Today at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` 
                  });
                  
                // Create action row with buttons
                const actionRow = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setLabel('🔗 Go to Thread')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://discord.com/channels/${interaction.guild.id}/${originalThread.id}`),
                  new ButtonBuilder()
                    .setLabel('✅ Close Task')
                    .setCustomId(`close_task_${originalThread.id}`)
                    .setStyle(ButtonStyle.Danger)
                );
                  
                await targetChannel.send({ 
                  embeds: [reopenEmbed],
                  components: [actionRow]
                });
                console.log(`Sent reopen notification to target channel as fallback: ${TARGET_CHANNEL_ID}`);
              }
            }
          } else {
            console.log(`Could not find original thread: ${originalThreadId}`);
            
            // Try to send to target channel if thread not found
            try {
              const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
              if (targetChannel) {
                const reopenEmbed = new EmbedBuilder()
                  .setColor(0x3498DB) // Blue color
                  .setTitle(`🔄 Task Reopened: ${taskTitle}`)
                  .setDescription(`This task has been reopened by ${interaction.user.toString()}.`)
                  .addFields({
                    name: 'Note',
                    value: 'The original thread could not be found. This notification is sent to the main channel instead.'
                  })
                  .setTimestamp()
                  .setFooter({ 
                    text: `Task ID: Unknown • Today at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` 
                  });
                  
                await targetChannel.send({ embeds: [reopenEmbed] });
                console.log(`Sent reopen notification to target channel instead: ${TARGET_CHANNEL_ID}`);
              }
            } catch (err) {
              console.error('Could not send reopen notification to target channel:', err);
            }
          }
        } catch (err) {
          console.error('Error sending reopen notification:', err);
        }
      } else {
        console.log('Could not determine original thread ID for reopen notification');
        
        // Try to send to the target channel as a fallback
        try {
          const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
          if (targetChannel) {
            const reopenEmbed = new EmbedBuilder()
              .setColor(0x3498DB) // Blue color
              .setTitle(`🔄 Task Reopened: ${taskTitle}`)
              .setDescription(`This task has been reopened by ${interaction.user.toString()}.`)
              .addFields({
                name: 'Note',
                value: 'The original thread could not be determined. This notification is sent to the main channel instead.'
              })
              .setTimestamp()
              .setFooter({ 
                text: `Today at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}` 
              });
              
            await targetChannel.send({ embeds: [reopenEmbed] });
            console.log(`Sent reopen notification to target channel as fallback: ${TARGET_CHANNEL_ID}`);
          }
        } catch (err) {
          console.error('Could not send reopen notification to target channel:', err);
        }
      }

      // 5️⃣ Provide feedback to the user
      await interaction.editReply({
        content: 'Thread reopened and all archive messages have been removed. A notification has been sent to the parent channel.',
        ephemeral: true
      });
    
    } catch (error) {
      console.error('Error handling reopen button:', error);
      if (interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while reopening the thread.',
          ephemeral: true
        }).catch(() => null);
      }
    }
  }
  
  // Handle close task button clicks
  else if (interaction.isButton() && interaction.customId.startsWith('close_task_')) {
    try {
      // Acknowledge the interaction immediately
      await interaction.deferReply({ ephemeral: true });
      
      // Parse out the thread ID from the button custom ID
      const threadId = interaction.customId.split('_')[2];
      console.log(`Processing close task request for thread: ${threadId}`);
      
      // Find the thread
      const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
      
      if (!thread || !thread.isThread()) {
        await interaction.editReply({
          content: 'Could not find the thread to close. It may have been deleted already.',
          ephemeral: true
        });
        return;
      }
      
      // Get the first message in the thread (for recreateThread function)
      const messages = await thread.messages.fetch({ limit: 1 });
      let firstMessage = messages.first();
      
      if (!firstMessage) {
        await interaction.editReply({
          content: 'Could not find any messages in the thread to mark as completed.',
          ephemeral: true
        });
        return;
      }
      
      // Delete the notification message with buttons
      await interaction.message.delete().catch(error => {
        console.error('Failed to delete notification message:', error);
      });
      
      // Use the existing recreateThread function to mark it as completed
      await recreateThread(firstMessage, interaction.user);
      
      // Provide feedback to the user
      await interaction.editReply({
        content: 'The task has been marked as completed and archived.',
        ephemeral: true
      });
      
    } catch (error) {
      console.error('Error handling close task button:', error);
      if (interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while closing the task.',
          ephemeral: true
        }).catch(() => null);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);