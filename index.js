/**
 * To generate a password for this console, run `node generate_credentials.js username password`
 */
const allowedUser = require('./credentials/user.json');

/**
 * Application constants
 */
const PORT = 8081;
const HOST = '0.0.0.0';
const HEARTBEAT_INTERVAL = 30000;
const MAX_CONNECTIONS = 1;
const KEY_FILE = 'key.pem';
const CERT_FILE = 'cert.pem';
const PASSPHRASE = 'supersecret';
const USER_SESSION_COOKIE = 'connect.sid';
const LOGIN_ROUTE = '/login';
const TIMEOUT_DURATION = 10000;

/**
 * Application dependency imports
 */
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const csrf = require('csurf');
const MemoryStore = require('memorystore')(session);
const cookieParser = require('cookie-parser');
const methodOverride = require('method-override');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
// const pty = require('node-pty');
const Multer = require('multer');
const Docker = require('dockerode');
const tar = require('tar');

const docker = new Docker();


/**
 * Default to CMD on Windows since PowerShell is not always available
 */
const shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';
const shells = {
  shell: {
    image: 'ubuntu',
    command: '/bin/bash'
  },
  java: {
    image: 'adoptopenjdk:11.0.6_10-jdk-hotspot-bionic',
    command: 'jshell'
  },
  node: {
    image: 'node:lts-alpine',
    command: 'node'
  },
  python: {
    image: 'python:3.8-alpine',
    command: 'python'
  }
};

const homeDir = os.platform() === 'win32' ? process.env['USERPROFILE'] : process.env['HOME'];
const uploadDir = path.resolve(__dirname, 'uploads');
const stagingDir = path.resolve(__dirname, 'staging');
let current_connections = 0;

// File upload middleware for handling multipart/form-data
const upload = Multer({
  storage: Multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

// Https server credentials. You don't want to transmit SSH key files as unencrypted plain text after all
const serverOpts = {
  key: fs.readFileSync(path.resolve(__dirname, 'credentials', KEY_FILE)),
  cert: fs.readFileSync(path.resolve(__dirname, 'credentials', CERT_FILE)),
  passphrase: PASSPHRASE
};

// Read the login page as a string so that the CSRF token can be injected via String.prototype.replace later.
// I'm not going to introduce a templating engine for 1 string replacement...
const loginPage = fs.readFileSync(path.resolve(__dirname, 'login', 'index.html'), 'utf8').replace(
  '{{shells}}',
  Object.keys(shells)
    .map(shell => `<option value="${shell}">${shell.charAt(0).toUpperCase() + shell.slice(1)}</option>`)
    .join('\n')
);

const app = express();
const terminals = {};
const socketIdsAllowed = new Set();
const disconnectTimers = {};
const allowedPaths = new Set([
  LOGIN_ROUTE,
  '/logout',
  '/styles/uikit.css',
  '/styles/main.css',
  '/scripts/uikit.js',
  '/scripts/uikit-icons.js'
]);

const cookieParserMiddleware = cookieParser();
const memorystore = new MemoryStore({
  checkPeriod: 600000
});
const sessionMiddleware = session({
  secret: 'superdupersecret',
  resave: true,
  saveUninitialized: true,
  store: memorystore,
  cookie: {
    expires: 600000,
    httpOnly: true,
    secure: true
  }
});
const csrfMiddleware = csrf({ cookie: true });

app.enable('trust proxy');
app.use(helmet());
app.use(methodOverride('_method'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParserMiddleware);
app.use(['/', '/login'], sessionMiddleware);

app.get(LOGIN_ROUTE, csrfMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(loginPage.replace('{{csrftoken}}', req.csrfToken())); // Not gonna bring in a whole templating engine for this
});
app.delete('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(noop);
    res.clearCookie(USER_SESSION_COOKIE);
  }
  res.clearCookie('console');
  res.redirect('/login');
});
app.post('/uploads', checkCredentials, upload.single('files[]'), (req, res) => {
  const remoteIp = getRemoteIp(req);
  if (!req.file || !req.file.filename || !terminals[remoteIp]) {
    return res.status(500).json({ status: 'Unable to receive file' });
  }
  const container = terminals[remoteIp].container;
  const filePath = path.relative(__dirname, req.file.path);
  const fileName = req.file.filename;
  const archiveFile = path.resolve(stagingDir, fileName + '.gz');
  tar
    .c({ gzip: true, file: archiveFile, preservePaths: false, cwd: uploadDir }, [fileName])
    .then(_ => container.putArchive(archiveFile, { path: '/' }))
    .then(_ => res.status(201).json({ status: 'received', file: req.file.filename, size: req.file.size }))
    .then(_ => {
      fs.unlink(filePath, noop);
      fs.unlink(archiveFile, noop);
    });
});
app.post('/resize', checkCredentials, (req, res) => {
  const remoteIp = getRemoteIp(req);
  const { cols, rows } = req.body;
  if (!terminals[remoteIp]) {
    return res.end();
  }
  terminals[remoteIp].sessionTerminal.resize(cols, rows);
  res.end();
});

// EVERYTHING BELOW THIS LINE IS CONNECTION LIMITED
app.use(connectionLimit(MAX_CONNECTIONS));
app.use('/', checkCredentials, express.static(path.resolve(__dirname, 'client')));
app.post(LOGIN_ROUTE, csrfMiddleware, (req, res) => {
  if (!req.session || !req.cookies[USER_SESSION_COOKIE]) {
    return res.redirect(LOGIN_ROUTE);
  }
  const { username, password, consoleType } = req.body;
  if (username === allowedUser.username && bcrypt.compareSync(password, allowedUser.password)) {
    req.session.user = { username };
    res.cookie('console', consoleType);
    socketIdsAllowed.add(req.cookies[USER_SESSION_COOKIE]);
    return res.redirect('/');
  }
  req.session.destroy(err => {
    res.redirect(LOGIN_ROUTE);
  });
});

const server = https.createServer(serverOpts, app);
const wss = new WebSocket.Server({ server });

/**
 * Requirements for opening a websocket connection:
 * 1. Number of existing connections is fewer than the max number of allowable connections
 * 2. Client must have a valid session id, which was given as a cookie on successful login
 *
 * Once the requirements have been satisfied, clear any disconnect timeout timer related to
 * the session id in case the client has reconnected after a temporary disconnect
 */
wss.on('connection', async (ws, req) => {
  const remoteIp = getRemoteIp(req);
  cookieParserMiddleware(req, null, noop);
  const sid = req.cookies[USER_SESSION_COOKIE];
  const consoleType = req.cookies['console'];
  if (current_connections >= MAX_CONNECTIONS) {
    console.log(`Rejecting socket connection from ${remoteIp}: Too many connections`);
    ws.terminate();
    return;
  }
  if (!socketIdsAllowed.has(sid)) {
    console.log(`Rejecting socket connection from ${remoteIp}: Invalid session ${sid}`);
    ws.terminate();
    return;
  }
  console.log(`Opening remote terminal for ${remoteIp}`);
  if (disconnectTimers[sid]) {
    clearTimeout(disconnectTimers[sid]);
    delete disconnectTimers[sid];
  }
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  const { container, stream } = await spawnTerminal(consoleType);

  const pid = container.id;
  terminals[remoteIp] = { pid, container };
  const terminalDataHandler = data => ws.send(data);
  stream.on('data', terminalDataHandler);
  const socketMessageHandler = message => stream.write(message);
  ws.on('message', socketMessageHandler);

  /**
   * On connection loss...
   * 1. destroy the associated terminal
   * 2. remove event handlers for the socket
   * 3. decrease the connection count
   * 4. set a disconnect timeout before removing the session id from the set of allowed ids in case
   *    the client reconnects within the timeout
   */
  const closeEventHandler = async () => {
    delete terminals[remoteIp];
    ws.removeEventListener('message', socketMessageHandler);
    decrementConnectionCount();
    disconnectTimers[sid] = setTimeout(() => {
      clearTimeout(disconnectTimers[sid]);
      delete disconnectTimers[sid];
      socketIdsAllowed.delete(sid);
      console.log(`Session id purged for ${remoteIp}`);
    }, TIMEOUT_DURATION);
    await container.kill({ force: true });
    await container.remove();
    console.log(`Session terminal pid ${pid} disposed for ${remoteIp}`);
  };
  ws.once('close', closeEventHandler);
  incrementConnectionCount();
});

/**
 * Periodically check whether existing websockets still have clients connected.
 * If not, terminate the sockets and let their close handlers dispose of their associated terminals
 */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(noop);
  });
}, HEARTBEAT_INTERVAL);

server.listen(PORT, HOST, () => console.log(`Server listening at ${HOST + ':' + PORT}`));

function checkCredentials(req, res, next) {
  if ((req.session && req.session.user && req.cookies[USER_SESSION_COOKIE]) || allowedPaths.has(req.path)) {
    return next();
  }
  res.redirect('/login');
}

function noop() {}

async function spawnTerminal(consoleType) {
  const container = await docker.createContainer({
    Image: shells[consoleType].image,
    Cmd: [shells[consoleType].command],
    OpenStdin: true,
    Tty: true
  });
  const attachOpts = { stream: true, stdin: true, stdout: true, stderr: true };
  const stream = await container.attach(attachOpts);
  await container.start();
  return { container, stream };
}

function connectionLimit(max = MAX_CONNECTIONS) {
  return (req, res, next) => {
    if (current_connections >= MAX_CONNECTIONS) {
      return res.status(502).json({ status: 'Max users reached', currentUsers: Object.keys(terminals) });
    }
    next();
  };
}

function getRemoteIp(req) {
  if (req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(/\s*,\s*/)[0];
  }
  return req.connection.remoteAddress;
}

function heartbeat() {
  this.isAlive = true;
}

function logConnectionCount() {
  console.log(`Connections: ${current_connections} / ${MAX_CONNECTIONS}`);
}

function incrementConnectionCount() {
  ++current_connections;
  logConnectionCount();
}

function decrementConnectionCount() {
  --current_connections;
  logConnectionCount();
}
