const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const MemoryStore = require('memorystore')(session);
const zlib = require('zlib');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Session store
const sessionStore = new MemoryStore({
  checkPeriod: 86400000 // prune expired entries every 24h
});

let latestFrame = null;
let takeLatestFrame = true;

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'res')));
app.use(express.static(path.join(__dirname, 'styles')));
app.use(cookieParser('your-secret-key'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  store: sessionStore,
  cookie: { secure: false } // Set to true if using https
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// In-memory user store (replace with database in production)
const users = [
  { username: 'root', password: 'DownWithTheSystem', isAdmin: true },
  { username: 'user1', password: 'password1', isAdmin: false },
  { username: 'user2', password: 'password2', isAdmin: false }
];

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.render('login', { isAdmin: false });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    req.session.user = user;
    if (user.isAdmin) {
      res.redirect('/admin/dashboard');
    } else {
      res.redirect('/user/dashboard');
    }
  } else {
    res.render('login', { error: 'Invalid credentials', isAdmin: false });
  }
});

app.get('/admin/login', (req, res) => {
  res.render('login', { isAdmin: true });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && u.password === password && u.isAdmin);
  if (user) {
    req.session.user = user;
    res.redirect('/admin/dashboard');
  } else {
    res.render('login', { error: 'Invalid credentials', isAdmin: true });
  }
});

app.get('/admin/dashboard', isAuthenticated, (req, res) => {
  if (req.session.user.isAdmin) {
    res.render('dashboard', { user: req.session.user });
  } else {
    res.redirect('/user/dashboard');
  }
});

app.get('/user/dashboard', isAuthenticated, (req, res) => {
  res.render('userDashboard', { user: req.session.user });
});

app.get('/fullscreen', isAuthenticated, (req, res) => {
  const display = parseInt(req.query.display) || 0;
  res.render('fullscreen', { initialDisplay: display });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/api/latest-frame', (req, res) => {
  console.log('Latest frame requested');
  if (latestFrame) {
    try {
      console.log('Serving frame, size:', latestFrame.length);
      
      zlib.unzip(latestFrame, (err, buffer) => {
        if (err) {
          console.error('Error decompressing frame:', err);
          res.status(500).send('Error processing frame');
        } else {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': buffer.length,
            'Cache-Control': 'no-store, must-revalidate'
          });
          res.end(buffer);
        }
      });
      
    } catch (error) {
      console.error('Error processing frame:', error);
      res.status(500).send('Error processing frame');
    }
  } else {
    console.log('No frame available');
    res.status(404).send('No frame available');
  }
});

let goClient = null;
let sessions = new Map();
let adminSocket = null;

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
  } else if (jsonMessage.type === 'terminateSession') {
    terminateSession(jsonMessage.sessionId);
  } else {
    console.log('Unknown message type:', jsonMessage.type);
  }
}

function sendSessionList() {
  if (adminSocket && adminSocket.readyState === WebSocket.OPEN) {
    const sessionList = Array.from(sessions.values()).map(({ id, type }) => ({ id, type }));
    adminSocket.send(JSON.stringify({ type: 'sessionList', sessions: sessionList }));
  }
}

function terminateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.type === 'Admin') {
      // If it's an admin session, destroy the express session
      if (session.expressSessionId) {
        sessionStore.destroy(session.expressSessionId, (err) => {
          if (err) {
            console.error('Error destroying express session:', err);
          }
        });
      }
    }
    session.ws.close();
    sessions.delete(sessionId);
    console.log(`Terminated session: ${sessionId}`);
    sendSessionList();
  }
}

setInterval(() => {
  takeLatestFrame = true;
}, 3000);

wss.on('connection', (ws, req) => {
  const sessionId = uuidv4();
  let sessionType = 'Browser';
  
  if (req.url === '/admin') {
    sessionType = 'Admin';
  } else if (req.url === '/ws') {
    sessionType = 'User';
  }
  
  let expressSessionId = null;
  if (sessionType === 'Admin') {
    // Parse the cookie to get the express session ID
    const cookies = cookieParser.signedCookies(req.headers.cookie, 'your-secret-key');
    expressSessionId = cookies['connect.sid'];
  }

  const session = { id: sessionId, type: sessionType, ws, expressSessionId };
  sessions.set(sessionId, session);

  console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);
  console.log(`New ${sessionType} connection: ${sessionId}`);

  if (sessionType === 'Admin') {
    adminSocket = ws;
    sendSessionList();
  }

  ws.on('message', (message) => {
    if (isJsonMessage(message)) {
      console.log('Received JSON message');
      try {
        const jsonMessage = JSON.parse(message.toString('utf8'));
        if (jsonMessage.type === 'goClient') {
          // Update session type to Go Client
          session.type = 'Go Client';
          goClient = ws;
          console.log(`Updated session ${sessionId} to Go Client`);
          sendSessionList(); // Update admin with new session list
        }
        handleJSONMessage(ws, jsonMessage);
      } catch (e) {
        console.error('Error parsing JSON:', e);
      }
    } else {
      console.log('Received binary frame data, length:', message.length);
      
      if (takeLatestFrame) {
        latestFrame = message;
        takeLatestFrame = false;
        console.log('Updated latest frame');
      }
      
      // Only send frame data to browser clients, excluding admin connections
      wss.clients.forEach((client) => {
        if (client !== goClient && client !== ws && client !== adminSocket && client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  });

  ws.on('close', () => {
    const closedSession = sessions.get(sessionId);
    if (closedSession && closedSession.type === 'Admin') {
      // If it's an admin session, destroy the express session
      if (closedSession.expressSessionId) {
        sessionStore.destroy(closedSession.expressSessionId, (err) => {
          if (err) {
            console.error('Error destroying express session:', err);
          }
        });
      }
    }

    sessions.delete(sessionId);
    if (ws === goClient) {
      console.log('Go client disconnected');
      goClient = null;
    } else if (ws === adminSocket) {
      console.log('Admin disconnected');
      adminSocket = null;
    } else {
      console.log(`${sessionType} client disconnected: ${sessionId}`);
    }
    sendSessionList();
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});