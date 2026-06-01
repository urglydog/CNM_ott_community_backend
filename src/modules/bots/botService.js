const path = require("path");
const dotenv = require("dotenv");
const OpenAI = require("openai");

const redis = require("../../config/redisConfig");
const reminderService = require("../reminders/reminderService");
const messageService = require("../messages/messageService");
const qdrantService = require("../../services/qdrantService");

dotenv.config({
  path:
    process.env.DOTENV_PATH || path.join(__dirname, "..", "..", "..", ".env"),
});

const SYSTEM_PROMPT =
  'Bạn là Trợ lý AI thông minh tích hợp trong ứng dụng nhắn tin OTT Community. Nhiệm vụ của bạn là hỗ trợ người dùng quản lý công việc, tóm tắt thông tin và giải đáp thắc mắc về chính sách cộng đồng một cách ngắn gọn, lịch sự. BẮT BUỘC gọi công cụ (tool) khi người dùng yêu cầu nhắc nhở, tóm tắt chat hoặc hỏi về chính sách, KHÔNG tự bịa câu trả lời.';
const MEMORY_KEY_PREFIX = "bot_session:";
const MEMORY_TTL_SECONDS = 24 * 60 * 60;
const MAX_HISTORY_MESSAGES = 10;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DEFAULT_BASE_URL =
  process.env.GEMINI_OPENAI_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GEMINI_API_KEY;

const agentTools = [
  {
    type: "function",
    function: {
      name: "createReminder",
      description:
        "Tạo lịch nhắc nhở cá nhân, báo thức hoặc lịch hẹn cho người dùng.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Nội dung cần nhắc",
          },
          time: {
            type: "string",
            description: "Thời gian chuẩn ISO 8601",
          },
        },
        required: ["content", "time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarizeConversation",
      description:
        "Tóm tắt nội dung tin nhắn nhóm, bóc tách công việc hoặc liệt kê các ý chính trong nhóm chat.",
      parameters: {
        type: "object",
        properties: {
          timeRange: {
            type: "string",
            description: "Khoảng thời gian, VD: morning, last_2_hours",
          },
          focus: {
            type: "string",
            description: "Mục tiêu tóm tắt, VD: tasks, general",
          },
        },
        required: ["timeRange", "focus"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "communityPolicySearch",
      description:
        "Tìm kiếm ngữ nghĩa (RAG) về quy định sử dụng, chính sách cộng đồng hoặc tài liệu SDK.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Câu hỏi hoặc từ khóa cần tra cứu",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

function getOpenAIClient() {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  return new OpenAI({
    apiKey: GEMINI_API_KEY,
    baseURL: DEFAULT_BASE_URL,
  });
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isGlobalAiConversation(conversationId) {
  return String(conversationId || "").startsWith("ai-global:");
}

function resolveReminderConversationId(context) {
  if (!isGlobalAiConversation(context.conversationId)) {
    return context.conversationId;
  }

  return `dm:${context.userId}:${context.userId}`;
}

function uniqueModels(models) {
  return [
    ...new Set(models.map((item) => String(item || "").trim()).filter(Boolean)),
  ];
}

function buildMemoryKey(userId) {
  return `${MEMORY_KEY_PREFIX}${String(userId || "").trim()}`;
}

function isTemporaryModelError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return status === 429 || status === 503;
}

function buildTemporaryUnavailableReply() {
  return "BotAI đang bận hoặc tạm quá tải nên chưa xử lý được yêu cầu này. Bạn thử lại sau ít phút giúp mình nhé.";
}

function extractAssistantText(message) {
  if (!message) return "";

  if (typeof message.content === "string") {
    return cleanText(message.content);
  }

  if (Array.isArray(message.content)) {
    return cleanText(
      message.content
        .map((item) => {
          if (typeof item === "string") return item;
          if (item?.type === "text") return item.text;
          return "";
        })
        .join(" "),
    );
  }

  return "";
}

async function getConversationHistory(userId) {
  const key = buildMemoryKey(userId);
  let rawHistory = null;

  try {
    rawHistory = await redis.get(key);
  } catch (error) {
    console.error(
      "[botService] Redis read failed, continuing without memory:",
      error.message,
    );
    return [];
  }

  if (!rawHistory) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawHistory);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string",
      )
      .slice(-MAX_HISTORY_MESSAGES);
  } catch (error) {
    console.error("[botService] Failed to parse Redis history:", error.message);
    return [];
  }
}

async function saveConversationHistory(userId, entries) {
  const key = buildMemoryKey(userId);
  const normalizedEntries = entries
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim(),
    )
    .slice(-MAX_HISTORY_MESSAGES);

  try {
    await redis.set(
      key,
      JSON.stringify(normalizedEntries),
      "EX",
      MEMORY_TTL_SECONDS,
    );
  } catch (error) {
    console.error(
      "[botService] Redis write failed, response will not be persisted:",
      error.message,
    );
  }
}

function buildMessages(history, userMessage) {
  const currentTime = new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
  });
  const dynamicPrompt = `${SYSTEM_PROMPT}\nThời gian hiện tại của hệ thống: ${currentTime}`;

  return [
    {
      role: "system",
      content: dynamicPrompt,
    },
    ...history,
    {
      role: "user",
      content: userMessage,
    },
  ];
}

async function createChatCompletion({ messages, tools }) {
  const openai = getOpenAIClient();
  const candidateModels = uniqueModels([
    DEFAULT_MODEL,
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest",
  ]);
  let lastError;

  for (const modelName of candidateModels) {
    try {
      return await openai.chat.completions.create({
        model: modelName,
        messages,
        tools,
        tool_choice: tools?.length ? "auto" : undefined,
        temperature: 0.3,
      });
    } catch (error) {
      lastError = error;
      console.error(
        `[botService] Chat completion failed with model ${modelName}:`,
        error?.message || error,
      );
    }
  }

  throw lastError;
}

async function emitStatus(onStatus, status, payload = {}) {
  if (typeof onStatus !== "function") {
    return;
  }

  await onStatus(status, payload);
}

async function executeTool(functionName, args, context) {
  switch (functionName) {
    case "createReminder": {
      const reminderPayload = {
        conversationId: resolveReminderConversationId(context),
        creatorId: context.userId,
        content: args.content,
        remindAt: args.time,
        repeat: "none",
      };

      const result = await reminderService.create(reminderPayload);
      return {
        ok: true,
        tool: functionName,
        reminderId: result?.reminder?.reminderId || null,
        remindAt: result?.reminder?.remindAt || args.time,
        content: result?.reminder?.content || args.content,
        reminder: result?.reminder || null,
        message: result?.message || null,
      };
    }

    case "summarizeConversation": {
      if (isGlobalAiConversation(context.conversationId)) {
        return {
          ok: false,
          tool: functionName,
          error:
            "SUMMARY_REQUIRES_CONTEXTUAL_CHAT",
          message:
            "Tóm tắt hội thoại chỉ khả dụng khi bạn mở AI từ một cuộc trò chuyện cụ thể.",
        };
      }

      const messageResult = await messageService.fetchMessages({
        conversationId: context.conversationId,
        timeRange: args.timeRange,
        focus: args.focus,
        currentUserId: context.userId,
        limit: 30,
      });

      return {
        ok: true,
        tool: functionName,
        timeRange: args.timeRange,
        focus: args.focus,
        conversationId: context.conversationId,
        messages: messageResult?.data || messageResult?.messages || [],
        count:
          messageResult?.count ||
          messageResult?.data?.length ||
          messageResult?.messages?.length ||
          0,
      };
    }

    case "communityPolicySearch": {
      const searchResult = await qdrantService.search({
        query: args.query,
        limit: 4,
      });

      return {
        ok: true,
        tool: functionName,
        query: args.query,
        ...searchResult,
      };
    }

    default:
      throw new Error(`Unsupported tool: ${functionName}`);
  }
}

async function processToolCalls(toolCalls, messages, context) {
  const executedTools = [];

  for (const toolCall of toolCalls) {
    const functionName = toolCall?.function?.name;
    const rawArguments = toolCall?.function?.arguments || "{}";
    let args = {};

    try {
      args = JSON.parse(rawArguments);
    } catch (error) {
      console.error(
        `[botService] Invalid tool arguments for ${functionName}:`,
        error.message,
      );

      const parseErrorResult = {
        ok: false,
        tool: functionName,
        error: "INVALID_TOOL_ARGUMENTS",
        details: "LLM returned malformed JSON arguments.",
        rawArguments,
      };

      console.warn("[botService] Tool arguments parse failed", {
        userId: context.userId,
        conversationId: context.conversationId,
        functionName,
        rawArguments,
      });

      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: functionName,
        content: JSON.stringify(parseErrorResult),
      });

      executedTools.push(parseErrorResult);
      continue;
    }

    try {
      console.log("[botService] Executing tool", {
        userId: context.userId,
        conversationId: context.conversationId,
        functionName,
        args,
      });

      const result = await executeTool(functionName, args, context);

      console.log("[botService] Tool execution result", {
        userId: context.userId,
        conversationId: context.conversationId,
        functionName,
        result,
      });

      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: functionName,
        content: JSON.stringify(result),
      });

      executedTools.push(result);
    } catch (error) {
      console.error(
        `[botService] Tool execution failed for ${functionName}:`,
        error.message,
      );

      const toolErrorResult = {
        ok: false,
        tool: functionName,
        error: error.message || "Tool execution failed",
      };

      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: functionName,
        content: JSON.stringify(toolErrorResult),
      });

      executedTools.push(toolErrorResult);
    }
  }

  return executedTools;
}

async function processChatMessage({
  userId,
  message,
  conversationId,
  onStatus,
}) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedMessage = cleanText(message);
  const normalizedConversationId = String(conversationId || "").trim();

  if (!normalizedUserId) {
    throw new Error("userId is required");
  }

  if (!normalizedMessage) {
    throw new Error("message is required");
  }

  try {
    const history = await getConversationHistory(normalizedUserId);
    const messages = buildMessages(history, normalizedMessage);

    console.log("[botService] User question", {
      userId: normalizedUserId,
      conversationId: normalizedConversationId || null,
      message: normalizedMessage,
      historyCount: history.length,
    });

    await emitStatus(onStatus, "bot_typing", {
      stage: "thinking",
      conversationId: normalizedConversationId || null,
    });

    const firstResponse = await createChatCompletion({
      messages,
      tools: agentTools,
    });
    const assistantMessage = firstResponse?.choices?.[0]?.message;
    const toolCalls = assistantMessage?.tool_calls || [];
    let finalReply = extractAssistantText(assistantMessage);
    let executedTools = [];

    console.log("[botService] First model response", {
      userId: normalizedUserId,
      conversationId: normalizedConversationId || null,
      hasToolCalls: toolCalls.length > 0,
      toolNames: toolCalls.map((item) => item?.function?.name).filter(Boolean),
      assistantPreview: finalReply || "",
    });

    if (assistantMessage) {
      messages.push({
        role: "assistant",
        content: assistantMessage.content || "",
        tool_calls: toolCalls,
      });
    }

    if (toolCalls.length > 0) {
      await emitStatus(onStatus, "bot_tool_executing", {
        stage: "tool_execution",
        conversationId: normalizedConversationId || null,
        toolNames: toolCalls.map((item) => item?.function?.name).filter(Boolean),
      });

      executedTools = await processToolCalls(toolCalls, messages, {
        userId: normalizedUserId,
        conversationId: normalizedConversationId,
      });

      await emitStatus(onStatus, "bot_typing", {
        stage: "finalizing",
        conversationId: normalizedConversationId || null,
      });

      const secondResponse = await createChatCompletion({
        messages,
        tools: agentTools,
      });
      const finalMessage = secondResponse?.choices?.[0]?.message;
      finalReply = extractAssistantText(finalMessage);

      console.log("[botService] Final model response after tools", {
        userId: normalizedUserId,
        conversationId: normalizedConversationId || null,
        reply: finalReply || "",
      });
    }

    const safeReply =
      finalReply ||
      "Xin lỗi, tôi chưa thể tạo phản hồi phù hợp lúc này. Bạn thử lại giúp tôi nhé.";

    if (!toolCalls.length) {
      console.log("[botService] Final model response without tools", {
        userId: normalizedUserId,
        conversationId: normalizedConversationId || null,
        reply: safeReply,
      });
    }

    await saveConversationHistory(normalizedUserId, [
      ...history,
      { role: "user", content: normalizedMessage },
      { role: "assistant", content: safeReply },
    ]);

    return {
      reply: safeReply,
      sender: "BotAI",
      status: toolCalls.length > 0 ? "tool_completed" : "completed",
      toolCalls: executedTools,
      conversationId: normalizedConversationId || null,
    };
  } catch (error) {
    console.error("[botService] processChatMessage error:", error);

    if (isTemporaryModelError(error)) {
      const fallbackReply = buildTemporaryUnavailableReply();
      const history = await getConversationHistory(normalizedUserId);

      await saveConversationHistory(normalizedUserId, [
        ...history,
        { role: "user", content: normalizedMessage },
        { role: "assistant", content: fallbackReply },
      ]);

      return {
        reply: fallbackReply,
        sender: "BotAI",
        status: "temporarily_unavailable",
        toolCalls: [],
        conversationId: normalizedConversationId || null,
        degraded: true,
      };
    }

    throw error;
  }
}

async function askAI(userQuestion, options = {}) {
  const result = await processChatMessage({
    userId: options.userId || "legacy-bot-user",
    message: userQuestion,
    conversationId: options.conversationId || "legacy-bot-conversation",
    onStatus: options.onStatus,
  });

  return result.reply;
}

module.exports = {
  SYSTEM_PROMPT,
  agentTools,
  askAI,
  getConversationHistory,
  processChatMessage,
  saveConversationHistory,
};
