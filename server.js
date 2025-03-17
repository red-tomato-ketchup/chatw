const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*', // Allow all origins (replace with your frontend URL for production)
        methods: ['GET', 'POST'],
    },
});

const messages = [];
const MAX_MESSAGES = 100; // Keep only the last 100 messages

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html', (err) => {
        if (err) {
            res.status(500).send('Error loading chat app');
        }
    });
});

io.on('connection', (socket) => {
    console.log('a user connected');

    // Send message history to the new user
    socket.emit('messageHistory', messages);

    // Listen for messages
    socket.on('message', (data) => {
        if (!data.username || !data.message) {
            console.error('Invalid message format:', data);
            return;
        }
        console.log('message:', data);
        messages.push(data); // Add message to history
        if (messages.length > MAX_MESSAGES) {
            messages.shift(); // Remove the oldest message
        }
        io.emit('message', data); // Broadcast to all users
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
