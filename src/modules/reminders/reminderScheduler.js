const reminderService = require("./reminderService");
const { notifyMessageCreated } = require("../notifications/notificationService");
const { saveMessage } = require("../messages/messageService");

const DEFAULT_INTERVAL_MS = 30 * 1000;

let timer = null;
let running = false;

async function tick(io) {
  if (running) return;
  running = true;

  try {
    const dueReminders = await reminderService.findDueReminders();
    for (const reminder of dueReminders) {
      const locked = await reminderService.markReminderFiring(reminder.reminderId);
      if (!locked) continue;

      const dueMessage = await reminderService.buildReminderDueMessage(reminder);
      let message = dueMessage;

      try {
        const persistedMessage = await saveMessage({
          conversationId: dueMessage.conversationId,
          senderId: dueMessage.senderId,
          contentType: dueMessage.contentType,
          content: dueMessage.content,
          reminderData: dueMessage.reminderData,
        });
        message = {
          ...persistedMessage,
          senderDisplayName: dueMessage.senderDisplayName,
          senderAvatarUrl: dueMessage.senderAvatarUrl,
        };
      } catch (persistError) {
        console.error(
          "[reminders] failed to persist due reminder message:",
          persistError.message,
        );
      }

      if (io) {
        io.to(reminder.conversationId).emit("reminder:due", {
          reminder,
          message,
        });
        io.to(reminder.conversationId).emit("notification:new_reminder", message);
      }
      await notifyMessageCreated(message, io);
      await reminderService.completeTriggeredReminder(reminder);
    }
  } catch (error) {
    console.error("[reminders] scheduler tick failed:", error.message);
  } finally {
    running = false;
  }
}

function startReminderScheduler(io, intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return timer;

  reminderService.ensureRemindersTable().catch((error) => {
    console.error("[reminders] table setup failed:", error.message);
  });

  timer = setInterval(() => {
    tick(io).catch((error) => {
      console.error("[reminders] scheduler failed:", error.message);
    });
  }, intervalMs);
  timer.unref?.();

  tick(io).catch((error) => {
    console.error("[reminders] initial tick failed:", error.message);
  });

  console.log(`[reminders] scheduler started (${intervalMs}ms)`);
  return timer;
}

function stopReminderScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  startReminderScheduler,
  stopReminderScheduler,
};
