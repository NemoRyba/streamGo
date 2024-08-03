const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using https
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// In-memory user store (replace with database in production)
const users = [
  { username: 'root', password: 'DownWithTheSystem' }
];

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/admin/login');
  }
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin/login', (req, res) => {
  res.render('login');
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user = user;
    res.redirect('/admin/dashboard');
  } else {
    res.render('login', { error: 'Invalid credentials' });
  }
});

app.get('/admin/dashboard', isAuthenticated, (req, res) => {
  res.render('dashboard', { user: req.session.user });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

let goClient = null;

function isJsonMessage(buffer) {
  const str = buffer.toString('utf8');
  try {
    JSON.parse(str);
    return true;
  } catch (e) {
    return false;
  }
}



function handleJSONMessage(ws, jsonMessage) {
  console.log('Parsed JSON message:', jsonMessage);

    if (jsonMessage.type === 'goClient') {
      console.log('Go client identified and connected');
      goClient = ws;
    } else if (jsonMessage.type === 'requestDisplayCount') {
      console.log('Received display count request from browser');
      if (goClient && goClient.readyState === WebSocket.OPEN) {
        console.log('Forwarding display count request to Go client');
        goClient.send(JSON.stringify(jsonMessage));
      } else {
        console.log('Go client not available to handle display count request');
        // Send error message to the browser
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Go client is not available. Please ensure the Go client is running and connected.'
        }));
      }
  } else if (jsonMessage.type === 'displayCount') {
    console.log(`Received display count: ${jsonMessage.count}`);
    wss.clients.forEach((client) => {
      if (client !== goClient && client.readyState === WebSocket.OPEN) {
        console.log('Forwarding display count to browser client');
        client.send(JSON.stringify(jsonMessage));
      }
    });
  } else if (jsonMessage.type === 'selectDisplay') {
    console.log(`Received select display request: ${jsonMessage.display}`);
    if (goClient && goClient.readyState === WebSocket.OPEN) {
      console.log('Forwarding select display request to Go client');
      goClient.send(JSON.stringify(jsonMessage));
    } else {
      console.log('Go client not available to handle select display request');
    }
  } else {
    console.log('Unknown message type:', jsonMessage.type);
  }
}

wss.on('connection', (ws, req) => {
  console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);

  ws.on('message', (message) => {
    if (isJsonMessage(message)) {
        console.log('Received JSON message');
        try {
          const jsonMessage = JSON.parse(message.toString('utf8'));
          handleJSONMessage(ws, jsonMessage);
        } catch (e) {
          console.error('Error parsing JSON:', e);
        }
    } else {
      console.log('Received binary frame data, length:', message.length);
      // Only send frame data to browser clients
      wss.clients.forEach((client) => {
        if (client !== goClient && client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  });

  ws.on('close', () => {
    if (ws === goClient) {
      console.log('Go client disconnected');
      goClient = null;
    } else {
      console.log('Browser client disconnected');
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});