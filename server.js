const express = require('express');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const MemoryStore = require('memorystore')(session);
const zlib = require('zlib');
const fs = require('fs');
const selfsigned = require('selfsigned');

const app = express();

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 365 });

const httpsOptions = {
  key: pems.private,
  cert: pems.cert
};

const server = https.createServer(httpsOptions, app);
const wss = new WebSocket.Server({ server });

// Session store
const sessionStore = new MemoryStore({
  checkPeriod: 86400000 // prune expired entries every 24h
});

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
  cookie: { secure: true } // Set to true for HTTPS
}));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const goClients = new Set();
let sessions = new Map();
let adminSocket = null;
let latestFrames = new Map();
let latestPreviews = new Map();

// In-memory user store (replace with database in production)
const users = [
  { username: 'root', password: 'DownWithTheSystem', isAdmin: true },
  { username: 'user1', password: 'password1', isAdmin: false },
  { username: 'user2', password: 'password2', isAdmin: false }
];

const HTTPS_PORT = 3000;
const HTTP_PORT = 80; // Standard HTTP port

const httpServer = http.createServer((req, res) => {
  res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
  res.end();
});

// Middleware to redirect HTTP to HTTPS
app.use((req, res, next) => {
  if (!req.secure) {
    return res.redirect('https://' + req.headers.host + req.url);
  }
  next();
});

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
};

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
// Routes
app.get('/', (req, res) => {
  console.log('Root route accessed, redirecting to /login');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  console.log('Login route accessed');
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
  res.render('fullscreen', { initialDisplay: display, user: req.session.user });
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});

app.get('/api/latest-frame', (req, res) => {
  const display = parseInt(req.query.display) || 0;
  console.log('Latest frame requested for display:', display);
  const latestFrame = latestFrames.get(display);
  
  if (latestFrame) {
    try {
      console.log('Serving frame for display:', display);
      const frameBuffer = Buffer.from(latestFrame, 'base64');
      
      zlib.unzip(frameBuffer, (err, buffer) => {
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
          console.log('Frame sent successfully');
        }
      });
    } catch (error) {
      console.error('Error processing frame:', error);
      res.status(500).send('Error processing frame');
    }
  } else {
    console.log('No frame available for display:', display);
    res.status(404).json({ message: 'No frame available' });
  }
}); 

app.get('/api/latest-preview', (req, res) => {
  const display = parseInt(req.query.display) || 0;
  console.log('Latest preview requested for display:', display);
  const latestPreview = latestPreviews.get(display);
  
  if (latestPreview) {
    try {
      console.log('Serving preview for display:', display);
      const previewBuffer = Buffer.from(latestPreview, 'base64');
      
      zlib.unzip(previewBuffer, (err, buffer) => {
        if (err) {
          console.error('Error decompressing preview:', err);
          res.status(500).send('Error processing preview');
        } else {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': buffer.length,
            'Cache-Control': 'no-store, must-revalidate'
          });
          res.end(buffer);
          console.log('Preview sent successfully');
        }
      });
    } catch (error) {
      console.error('Error processing preview:', error);
      res.status(500).send('Error processing preview');
    }
  } else {
    console.log('No preview available for display:', display);
    requestPreviewFromGoClient(display);
    res.status(202).json({ message: 'Preview requested, please try again shortly' });
  }
});
// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const sessionId = uuidv4();
  let sessionType = 'User';
  let username = 'Unknown User';

  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname;
  const params = new URLSearchParams(url.search);

  if (pathname === '/admin') {
    sessionType = 'Admin';
    username = params.get('username') || 'Unknown Admin';
    adminSocket = ws;
    sendSessionList();
  } else if (pathname === '/ws') {
    const clientType = params.get('clientType');
    if (clientType === 'go') {
      goClients.add(ws);
      console.log('New Go client connected');
      sessionType = 'GoClient';
      sendDisplayCountRequest(ws);
    } else {
      sessionType = 'User';
      username = params.get('username') || 'Unknown User';
    }
  } else if (pathname.startsWith('/direct/')) {
    sessionType = 'Direct';
    username = params.get('username') || 'Unknown Direct User';
  }

  const session = { id: sessionId, type: sessionType, ws, selectedDisplay: null, username };
  sessions.set(sessionId, session);

  console.log(`New ${sessionType} connection: ${sessionId} for user: ${username}`);

  ws.on('message', (message) => {
    try {
      const jsonMessage = JSON.parse(message);
      console.log('Received message:', jsonMessage.type);
      
      handleJSONMessage(ws, jsonMessage, sessionType, sessionId);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    if (sessionType === 'User') {
      removeWatcher(sessionId);
    }
    sessions.delete(sessionId);
    console.log(`${sessionType} client disconnected: ${sessionId}`);
    if (sessionType === 'Admin') {
      adminSocket = null;
    } else if (sessionType === 'GoClient') {
      goClients.delete(ws);
      console.log('Go client disconnected');
    }
    sendSessionList();
  });
});

function handleJSONMessage(ws, jsonMessage, sessionType, sessionId) {
  console.log('Handling JSON message:', jsonMessage.type, 'for session type:', sessionType);
  
  switch (jsonMessage.type) {
    case 'goClient':
      console.log('Go client identified');
      break;
    case 'displayCount':
      broadcastToClients(jsonMessage);
      break;
    case 'frame':
      handleFrame(jsonMessage);
      break;
    case 'requestFrame':
      requestFrameFromGoClient(jsonMessage.display, jsonMessage.isPreview, sessionId);
      break;
    case 'selectDisplay':
      removeWatcher(sessionId);
      addWatcher(sessionId, jsonMessage.display);
      break;
    case 'unselectDisplay':
      removeWatcher(sessionId);
      break;
    case 'requestSessionList':
      sendSessionList();
      break;
    case 'terminateSession':
      terminateSession(jsonMessage.sessionId);
      break;
    case 'terminateUserSessions':
      terminateUserSessions(jsonMessage.username);
      break;
    default:
      console.log("Unknown message type:", jsonMessage.type);
  }
}

function sendDisplayCountRequest(ws) {
  ws.send(JSON.stringify({ type: 'requestDisplayCount' }));
}

function handleFrame(frameMessage) {
  const { display, data } = frameMessage;
  latestFrames.set(display, data);
  notifyClientsOfNewFrame(display);
}

function notifyClientsOfNewFrame(display) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'frameAvailable', display }));
    }
  });
}

function broadcastToClients(message) {
  wss.clients.forEach((client) => {
    if (!goClients.has(client) && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function addWatcher(sessionId, display) {
  const session = sessions.get(sessionId);
  if (session) {
    session.selectedDisplay = display;
    requestFrameFromGoClient(display, false, sessionId);
  }
}

function removeWatcher(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.selectedDisplay = null;
  }
}

function requestFrameFromGoClient(display, isPreview, sessionId) {
  for (let client of goClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'requestFrame',
        display,
        isPreview,
        userID: sessionId
      }));
      return;
    }
  }
  console.log('No available Go clients to handle the frame request');
}

function requestPreviewFromGoClient(display) {
  for (let client of goClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'requestPreview', display }));
      return;
    }
  }
  console.log('No available Go clients to handle the preview request');
}

function sendSessionList() {
  if (adminSocket && adminSocket.readyState === WebSocket.OPEN) {
    const groupedSessions = {};
    Array.from(sessions.values()).forEach(({ id, type, username }) => {
      if (!groupedSessions[username]) {
        groupedSessions[username] = [];
      }
      groupedSessions[username].push({ id, type });
    });
    console.debug('Sending updated session list to admin');
    adminSocket.send(JSON.stringify({ type: 'sessionList', sessions: groupedSessions }));
  }
}

function terminateSession(sessionId) {
  console.debug('Attempting to terminate session: ' + sessionId);
  const session = sessions.get(sessionId);
  if (session) {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'forceLogout' }));
    }
    session.ws.close();
    sessions.delete(sessionId);
    console.debug('Session terminated and removed: ' + sessionId);
    sendSessionList();
  } else {
    console.debug('Session not found: ' + sessionId);
  }
}

function terminateUserSessions(username) {
  console.debug('Attempting to terminate all sessions for user: ' + username);
  Array.from(sessions.values()).forEach((session) => {
    if (session.username === username) {
      terminateSession(session.id);
    }
  });
}

server.listen(HTTPS_PORT, () => {
  console.log(`HTTPS Server running on port ${HTTPS_PORT}`);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP Server running on port ${HTTP_PORT} (redirecting to HTTPS)`);
});

console.log('Server script executed. Check for errors above.');