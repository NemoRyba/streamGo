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

let latestFrames = new Map();

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
          }
        });
        
      } catch (error) {
        console.error('Error processing frame:', error);
        res.status(500).send('Error processing frame');
      }
    } else {
      console.log('No frame available for display:', display);
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
      if (goClient && goClient.readyState === WebSocket.OPEN) {
        goClient.send(JSON.stringify(jsonMessage));
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Go client is not available. Please ensure the Go client is running and connected.'
        }));
      }
    } else if (jsonMessage.type === 'displayCount') {
      wss.clients.forEach((client) => {
        if (client !== goClient && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(jsonMessage));
        }
      });
    } else if (jsonMessage.type === 'selectDisplay' || jsonMessage.type === 'unselectDisplay') {
      if (goClient && goClient.readyState === WebSocket.OPEN) {
        goClient.send(JSON.stringify(jsonMessage));
      } else {
        console.log('Go client not available to handle display selection');
      }
    } else if (jsonMessage.type === 'terminateSession') {
        console.debug('Termination request received for session: ' + jsonMessage.sessionId);
        terminateSession(jsonMessage.sessionId);
      } else {
        console.log('Unknown message type:', jsonMessage.type);
      }
  }

  function sendSessionList() {
    if (adminSocket && adminSocket.readyState === WebSocket.OPEN) {
        const sessionList = Array.from(sessions.values()).map(({ id, type }) => ({ id, type }));
        console.debug('Sending updated session list to admin');
        adminSocket.send(JSON.stringify({ type: 'sessionList', sessions: sessionList }));
    }
}

function terminateSession(sessionId) {
    console.debug('Attempting to terminate session: ' + sessionId);
    const session = sessions.get(sessionId);
    if (session) {
        console.debug('Session found. Type: ' + session.type);
        if (session.type === 'Admin') {
            if (session.expressSessionId) {
                sessionStore.destroy(session.expressSessionId, (err) => {
                    if (err) {
                        console.error('Error destroying express session:', err);
                    }
                });
            }
        }
        // Send logout message to the client
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
      const cookies = cookieParser.signedCookies(req.headers.cookie, 'your-secret-key');
      expressSessionId = cookies['connect.sid'];
    }
  
    const session = { id: sessionId, type: sessionType, ws, expressSessionId, selectedDisplay: null };
    sessions.set(sessionId, session);
  
    console.log(`New ${sessionType} connection: ${sessionId}`);
  
    if (sessionType === 'Admin') {
      adminSocket = ws;
      sendSessionList();
    }
  
    ws.on('message', (message) => {
      try {
        const jsonMessage = JSON.parse(message);
        if (jsonMessage.type === 'goClient') {
          session.type = 'Go Client';
          goClient = ws;
          console.log(`Updated session ${sessionId} to Go Client`);
          sendSessionList();
        } else if (jsonMessage.type === 'frame') {
          console.log(`Received frame for display ${jsonMessage.display}, size: ${jsonMessage.data.length} characters`);
          latestFrames.set(jsonMessage.display, jsonMessage.data);
          
          // Send frame to all connected browser clients that have selected this display
          sessions.forEach((session) => {
            if (session.type === 'User' && session.selectedDisplay === jsonMessage.display && session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(JSON.stringify(jsonMessage));
            }
          });
        } else if (jsonMessage.type === 'selectDisplay') {
          session.selectedDisplay = jsonMessage.display;
          handleJSONMessage(ws, jsonMessage);
        } else if (jsonMessage.type === 'unselectDisplay') {
          session.selectedDisplay = null;
          handleJSONMessage(ws, jsonMessage);
        } else {
          handleJSONMessage(ws, jsonMessage);
        }
      } catch (e) {
        console.error('Error parsing message:', e);
      }
    });
  
    ws.on('close', () => {
      const closedSession = sessions.get(sessionId);
      if (closedSession && closedSession.type === 'Admin') {
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