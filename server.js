const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const messages = [];

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    console.log('a user connected');

    socket.emit('messageHistory', messages);

    socket.on('message', (data) => {
        console.log('message:', data);
        messages.push(data); // Add message to history
        io.emit('message', data); // Broadcast to all users
    });

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});