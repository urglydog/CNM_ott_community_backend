const path = require("path");
require("dotenv").config({
  path: process.env.DOTENV_PATH || path.join(__dirname, "..", ".env"),
  override: true,
});

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

// Modular Routes
const authRoutes = require("./modules/auth/authRoutes");
const userRoutes = require("./modules/users/userRoutes");
const friendRoutes = require("./modules/users/friendRoutes");
const messageRoutes = require("./modules/chat/messageRoutes");
const groupRoutes = require("./modules/chat/groupRoutes");
const channelRoutes = require("./modules/chat/channelRoutes");
const callRoutes = require("./modules/chat/callRoutes");
const botRoutes = require("./modules/chat/botRoutes");
const uploadRoutes = require("./modules/media/uploadRoutes");
const statsRoutes = require("./modules/stats/statsRoutes");
const messageRevokeRoutes = require("./modules/chat/messageRevokeRoutes");
const messageDeleteRoutes = require("./modules/chat/messageDeleteRoutes");

// Socket Handler
const {
  handleSocketConnection,
  socketAuthMiddleware,
  initializeIO,
} = require("./socket/socketHandler");

const app = express();
const server = http.createServer(app);

// eslint-disable-next-line no-console
console.log(`[BOOT] OTP_EMAIL_PROVIDER=${process.env.OTP_EMAIL_PROVIDER || 'console'} OTP_SMS_PROVIDER=${process.env.OTP_SMS_PROVIDER || 'console'}`);

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN || "http://localhost:3000,http://localhost:3001"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  },
});

app.set("socketio", io);

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve static uploads
app.use("/public", express.static(path.join(__dirname, "..", "public")));
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "ott-community-backend" });
});

// API Routes initialization
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/messages-extension", messageRevokeRoutes);
app.use("/api/messages-extension", messageDeleteRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/v1/bot", botRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/stats", statsRoutes);

// Socket.io Middleware and Initialization
io.use(socketAuthMiddleware);
initializeIO(io);

io.on("connection", (socket) => {
  handleSocketConnection(io, socket);
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `OTT Community backend (Restructured) is running on port ${PORT}`,
  );
});

module.exports = { app, server, io };
