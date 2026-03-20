require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const userRoutes = require('./routes/userRoutes');
const groupRoutes = require('./routes/groupRoutes');
const messageRoutes = require('./routes/messageRoutes');
const channelRoutes = require('./routes/channelRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const statsRoutes = require('./routes/statsRoutes');

const { handleSocketConnection } = require('./services/socketService');

const app = express();
const server = http.createServer(app);

const allowedOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

const io = new Server(server, {
	cors: {
		origin: allowedOrigin,
		methods: ['GET', 'POST']
	}
});

app.use(cors({
	origin: allowedOrigin,
	credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static uploads if you later proxy S3 or store local files (optional)
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
	res.json({ status: 'ok', service: 'ott-community-backend' });
});

app.use('/api/users', userRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/stats', statsRoutes);

io.on('connection', (socket) => {
	handleSocketConnection(io, socket);
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`OTT Community backend is running on port ${PORT}`);
});

module.exports = { app, server, io };
