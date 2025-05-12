// Discord Bot for Thread Recreation on Checkmark
const { Client, GatewayIntentBits, Partials } = require('discord.js');
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
const COMPLETION_CHANNEL_ID = process.env.COMPLETION_CHANNEL_ID || "completed-tasks"; // Channel to post completion messages
const CHECKMARK_EMOJIS = ['✅', '✓', '☑️', '🗸', '☑', '✔️', '✔'];

// When the client is ready
client.once('ready', () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
  console.log(`Monitoring for checkmark reactions in channel: ${TARGET_CHANNEL_ID}`);
  console.log(`Recreating threads in channel: ${COMPLETION_CHANNEL_ID}`);
  
  // Check if completion channel exists and create it if needed
  client.guilds.cache.forEach(async (guild) => {
    // Check if the channel is specified by name rather than ID
    if (isNaN(COMPLETION_CHANNEL_ID)) {
      // Check if the channel already exists
      const existingChannel = guild.channels.cache.find(
        channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0
      );
      
      if (!existingChannel) {
        try {
          // Create the channel if it doesn't exist
          const newChannel = await guild.channels.create({
            name: COMPLETION_CHANNEL_ID,
            type: 0, // GUILD_TEXT
            topic: 'Automatically archived completed tasks and threads'
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
      // First try to fetch by ID
      completionChannel = await client.channels.fetch(COMPLETION_CHANNEL_ID);
    } catch (err) {
      // If that fails, try to find a channel by name
      completionChannel = message.guild.channels.cache.find(
        channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0 // 0 is GUILD_TEXT
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
      // The message is inside a thread
      originalThread = message.channel;
      
      // Try to get the starter message of the thread
      try {
        threadParentMessage = await originalThread.fetchStarterMessage();
      } catch (err) {
        console.log('Could not fetch thread starter message:', err);
        // Continue without the starter message
      }
      
    } else if (message.thread) {
      // The message is a thread starter
      originalThread = message.thread;
      threadParentMessage = message;
    } else {
      // The message is not part of a thread
      console.log('Message is not part of a thread. Creating standard completion notification instead.');
      await createCompletionNotification(message, user);
      return;
    }
    
    // Ensure the thread is fully fetched
    await originalThread.fetch();
    
    // Get thread name
    const threadName = originalThread.name || "Completed Thread";
    
    // Create the thread starter content
    let threadStarter = `## Thread Completed ✅
**Original Thread:** ${threadName}
**Marked complete by:** ${user.tag}
**Completed at:** ${new Date().toLocaleString()}
**Original Thread Link:** https://discord.com/channels/${message.guild.id}/${originalThread.id}
`;

    // Add information about the parent message if available
    if (threadParentMessage) {
      threadStarter += `\n**Thread Started By:** ${threadParentMessage.author.tag}
**Thread Start Message:** ${threadParentMessage.content ? threadParentMessage.content.substring(0, 200) : "(No content)"}${threadParentMessage.content && threadParentMessage.content.length > 200 ? "..." : ""}
`;
    }
    
    threadStarter += "\n--- Thread Contents Below ---";

    // Start the new thread
    const newThread = await completionChannel.threads.create({
      name: `✅ ${threadName}`,
      message: {
        content: threadStarter
      },
      autoArchiveDuration: 10080 // 1 week
    });
    
    console.log(`Created new thread: ${newThread.name} (${newThread.id})`);
    
    // Fetch messages from the original thread (up to 100 - Discord API limitation)
    const originalMessages = await originalThread.messages.fetch({ limit: 100 });
    
    // Sort messages chronologically (oldest first)
    const sortedMessages = Array.from(originalMessages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    
    // Check if we need to add a warning about message limit
    if (originalMessages.size >= 100) {
      await newThread.send('⚠️ **Note:** This thread had more than 100 messages. Only the most recent 100 messages are shown here due to Discord API limitations.');
    }
    
    // Post each message to the new thread
    for (const originalMessage of sortedMessages) {
      // Skip system messages
      if (originalMessage.system) continue;
      
      // Format the message
      let messageContent = `**${originalMessage.author.tag}** (${new Date(originalMessage.createdTimestamp).toLocaleString()}):\n`;
      
      // Add message content if available
      if (originalMessage.content) {
        messageContent += originalMessage.content;
      }
      
      // Handle embeds
      if (originalMessage.embeds && originalMessage.embeds.length > 0) {
        messageContent += "\n[Message contained embeds]";
      }
      
      // Handle attachments
      if (originalMessage.attachments && originalMessage.attachments.size > 0) {
        messageContent += "\n**Attachments:**\n";
        originalMessage.attachments.forEach(attachment => {
          messageContent += `- ${attachment.name}: ${attachment.url}\n`;
        });
      }
      
      // Split messages if they're too long (Discord 2000 character limit)
      if (messageContent.length > 1900) {
        const chunks = splitTextIntoChunks(messageContent, 1900);
        for (const chunk of chunks) {
          await newThread.send(chunk);
          // Small delay to maintain order
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      } else {
        await newThread.send(messageContent);
        // Small delay to maintain order
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    
    // Add a completion message
    await newThread.send('--- End of Thread Content ---');
    
    // Mark the original message with a special reaction to show it was processed
    await message.react('📋');
    
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
    // Determine where to post the message - use the completion channel
    const targetChannel = completionChannel;
    
    if (!targetChannel) {
      console.error('Could not find target channel for summary message');
      return;
    }
    
    // Count participants and messages in the thread
    const memberCount = originalThread.memberCount || 'Unknown';
    
    // Get first and last messages to calculate duration
    const messages = await originalThread.messages.fetch({ limit: 100 });
    const sortedMessages = Array.from(messages.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    
    const firstMessage = sortedMessages[0];
    const lastMessage = sortedMessages[sortedMessages.length - 1];
    
    let threadDuration = 'Unknown';
    if (firstMessage && lastMessage) {
      const durationMs = lastMessage.createdTimestamp - firstMessage.createdTimestamp;
      // Format duration nicely
      if (durationMs < 60000) { // less than a minute
        threadDuration = `${Math.round(durationMs / 1000)} seconds`;
      } else if (durationMs < 3600000) { // less than an hour
        threadDuration = `${Math.round(durationMs / 60000)} minutes`;
      } else if (durationMs < 86400000) { // less than a day
        threadDuration = `${Math.round(durationMs / 3600000)} hours`;
      } else { // days or more
        threadDuration = `${Math.round(durationMs / 86400000)} days`;
      }
    }
    
    // Count unique participants
    const participants = new Set();
    sortedMessages.forEach(msg => {
      if (msg.author && !msg.author.bot) {
        participants.add(msg.author.id);
      }
    });
    
    // Get keywords/topics - extract from thread name and first message
    let keywords = 'N/A';
    if (originalThread.name) {
      // Simple keyword extraction - split by common separators and take words longer than 3 chars
      const extractedKeywords = originalThread.name
        .split(/[\s,.-_]+/)
        .filter(word => word.length > 3)
        .slice(0, 5); // Take first 5 keywords
      
      if (extractedKeywords.length > 0) {
        keywords = extractedKeywords.join(', ');
      }
    }
    
    // Format the summary message with useful stats and links
    const summaryEmbed = {
      color: 0x00FF00, // Green color for completion
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
    
    // Send the summary message to the original channel
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
      // First try to fetch by ID
      completionChannel = await client.channels.fetch(COMPLETION_CHANNEL_ID);
    } catch (err) {
      // If that fails, try to find a channel by name
      completionChannel = message.guild.channels.cache.find(
        channel => channel.name === COMPLETION_CHANNEL_ID && channel.type === 0 // 0 is GUILD_TEXT
      );
      
      if (!completionChannel) {
        console.error(`Could not find completion channel with ID or name: ${COMPLETION_CHANNEL_ID}`);
        return;
      }
    }
    
    // Format the message content
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
    
    // Format date for better readability
    const formattedDate = new Date().toLocaleString('en-US', { 
      weekday: 'short',
      month: 'short', 
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit', 
      minute: '2-digit'
    });
    
    // Format the completion message
    const completionMessage = `
## Task Completed ✅
**Task:** ${contentToDisplay}
**Originally posted by:** ${message.author ? message.author.tag : "Unknown User"}
**Marked complete by:** ${user.tag}
**Completed at:** ${formattedDate}
**Original Message Link:** https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}
`;
    
    // Send the completion message
    const archiveMessage = await completionChannel.send(completionMessage);
    console.log(`Completion message posted to channel: ${COMPLETION_CHANNEL_ID}`);
    
    // Add a reaction to mark as processed
    await message.react('📋');
    
    // NEW: Also post a summary in the completed-tasks channel
    // Use the existing completionChannel that we've already fetched
    const summaryEmbed = {
      color: 0x00FF00, // Green color for completion
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
    
    // Send the summary to the completed-tasks channel
    await completionChannel.send({ embeds: [summaryEmbed] });
    
  } catch (error) {
    console.error('Error creating completion notification:', error);
  }
}

// Helper function to split long text into chunks
function splitTextIntoChunks(text, maxLength) {
  const chunks = [];
  let currentChunk = '';
  
  // Split by lines first to avoid breaking in the middle of a line
  const lines = text.split('\n');
  
  for (const line of lines) {
    // If adding this line would exceed the max length, push the current chunk and start a new one
    if (currentChunk.length + line.length + 1 > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line + '\n';
    } else {
      currentChunk += line + '\n';
    }
  }
  
  // Add the last chunk if it's not empty
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

// Listen for message reactions being added
client.on('messageReactionAdd', async (reaction, user) => {
  // Ignore reactions from bots
  if (user.bot) return;
  
  try {
    // Partial reactions need to be fetched to access their data
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        console.error('Something went wrong when fetching the reaction:', error);
        return;
      }
    }
    
    // Check if the message is also partial and fetch it if needed
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (error) {
        console.error('Something went wrong when fetching the message:', error);
        return;
      }
    }
    
    // Get the channel ID - for thread messages, we need to check the parent channel
    let relevantChannelId;
    
    if (reaction.message.channel.isThread()) {
      // For messages in threads, check if the parent channel is our target
      const parentChannel = reaction.message.channel.parent;
      if (parentChannel) {
        relevantChannelId = parentChannel.id;
      }
    } else {
      // For regular messages
      relevantChannelId = reaction.message.channel.id;
    }
    
    // Check if it's any checkmark variant in the target channel or a thread in the target channel
    const isInTargetChannel = relevantChannelId === TARGET_CHANNEL_ID;
    const isInTargetThread = reaction.message.channel.isThread() && 
                             reaction.message.channel.parentId === TARGET_CHANNEL_ID;
    
    if ((isInTargetChannel || isInTargetThread) && CHECKMARK_EMOJIS.includes(reaction.emoji.name)) {
      console.log(`Checkmark (${reaction.emoji.name}) detected from ${user.tag} in ${reaction.message.channel.isThread() ? 'thread' : 'channel'}`);
      
      // Check if this message already has a bot completion reaction (to avoid duplicates)
      if (reaction.message.reactions.cache.some(r => 
        r.emoji.name === '📋' && 
        r.users.cache.has(client.user.id))) {
        console.log('This message was already marked as completed. Skipping.');
        return;
      }
      
      // Recreate the thread or create a completion notification
      await recreateThread(reaction.message, user);
    }
  } catch (error) {
    console.error('Error processing reaction:', error);
  }
});

// Login to Discord with your token
client.login(process.env.DISCORD_TOKEN);