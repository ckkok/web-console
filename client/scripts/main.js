const CONNECTED_MESSAGE = 'Terminal connected';
const DISCONNECTED_MESSAGE = 'Connection lost';
const NOTIFICATION_POSITION = 'bottom-left';
const NOTIFICATION_TIMEOUT_IN_MS = 2000;
const CONNECTION_RETRY_INTERVAL = 2000;

const statusContainer = document.getElementById('status');

const alertError = message => {
  UIkit.notification({
    message,
    status: 'danger',
    pos: NOTIFICATION_POSITION,
    timeout: NOTIFICATION_TIMEOUT_IN_MS
  });
};

const alertOk = message => {
  UIkit.notification({
    message,
    status: 'success',
    pos: NOTIFICATION_POSITION,
    timeout: NOTIFICATION_TIMEOUT_IN_MS
  });
};

const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';

const terminal = new Terminal();
const terminalElement = document.getElementById('terminal');

let socketRetryTimer;
let socket;
let attachAddon;
const onConnect = () => alertOk(CONNECTED_MESSAGE);
const onDisconnect = () => {
  alertError(DISCONNECTED_MESSAGE);
  socket.removeEventListener('open', onConnect);
  socket.removeEventListener('error', onDisconnect);
  socket.removeEventListener('close', onDisconnect);
  socket = null;
  if (socketRetryTimer) {
    clearTimeout(socketRetryTimer);
  }
  socketRetryTimer = setTimeout(setupSocket, CONNECTION_RETRY_INTERVAL);
};

function setupSocket() {
  try {
    if (socketRetryTimer) {
      clearTimeout(socketRetryTimer);
      socketRetryTimer = null;
    }
    socket = new WebSocket(protocol + window.location.host);
    socket.addEventListener('open', onConnect);
    socket.addEventListener('close', onDisconnect);
    socket.addEventListener('error', onDisconnect);
    if (attachAddon) {
      attachAddon.dispose();
    }
    attachAddon = new AttachAddon.AttachAddon(socket);
    terminal.loadAddon(attachAddon);
  } catch (e) {
    socketRetryTimer = setTimeout(setupSocket, CONNECTION_RETRY_INTERVAL);
  }
}

setupSocket();

const fitAddon = new FitAddon.FitAddon();
terminal.loadAddon(fitAddon);

const searchAddon = new SearchAddon.SearchAddon();
terminal.loadAddon(searchAddon);

const webLinksAddon = new WebLinksAddon.WebLinksAddon();
terminal.loadAddon(webLinksAddon);

terminal.open(terminalElement);
const resize = () => {
  const dimensions = fitAddon.proposeDimensions(); // We avoid using fitAddon.fit() as that would incur the expensive dimension calculations twice
  fetch('/resize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dimensions)
  }).then(_ => {
    terminal.resize(dimensions.cols, dimensions.rows);
  });
};
resize();

window.addEventListener('resize', resize);

const bar = document.getElementById('js-progressbar');

UIkit.upload('.js-upload', {
  url: '/uploads',
  multiple: false,
  loadStart: function(e) {
    bar.removeAttribute('hidden');
    bar.max = e.total;
    bar.value = e.loaded;
  },
  progress: function(e) {
    bar.max = e.total;
    bar.value = e.loaded;
  },
  loadEnd: function(e) {
    bar.max = e.total;
    bar.value = e.loaded;
  },
  completeAll: function() {
    setTimeout(function() {
      bar.setAttribute('hidden', 'hidden');
    }, 1000);
    alertOk('Upload completed');
  }
});
