const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

const messages = [];
const MAX_MESSAGES = 100;
const onlineUsers = new Map(); // Stores username -> lastSeen timestamp
const typingUsers = new Set(); // Stores currently typing users

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html', (err) => {
        if (err) res.status(500).send('Error loading chat app');
    });
});

io.on('connection', (socket) => {
    console.log('a user connected');

    // Send message history to new user
    socket.emit('messageHistory', messages);

    // Handle user coming online
    socket.on('userOnline', (username) => {
        onlineUsers.set(username, new Date());
        socket.username = username; // Store username on socket
        io.emit('updateOnlineUsers', Array.from(onlineUsers));
    });

    // Handle messages
    socket.on('message', (data) => {
        if (!data.username || !data.message) return;
        
        messages.push(data);
        if (messages.length > MAX_MESSAGES) messages.shift();
        
        io.emit('message', data);
        typingUsers.delete(data.username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    // Handle typing indicators
    socket.on('typing', (username) => {
        typingUsers.add(username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    socket.on('stopTyping', (username) => {
        typingUsers.delete(username);
        io.emit('updateTypingUsers', Array.from(typingUsers));
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        if (socket.username) {
            onlineUsers.set(socket.username, new Date()); // Update last seen
            typingUsers.delete(socket.username);
            
            io.emit('updateOnlineUsers', Array.from(onlineUsers));
            io.emit('updateTypingUsers', Array.from(typingUsers));
        }
        console.log('user disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
