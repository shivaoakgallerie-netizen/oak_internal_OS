'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const APP_URL = 'https://cerulean-youtiao-fd7466.netlify.app/';
const APP_ORIGIN = new URL(APP_URL).origin;
const ALLOWED_PERMISSIONS = new Set(['notifications']);

app.setAppUserModelId('com.oakgallerie.oakdesk.desktop');
app.enableSandbox();

function isOakDeskUrl(value) {
  try {
    return new URL(value).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function configureSession() {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    callback(isOakDeskUrl(requestingUrl) && ALLOWED_PERMISSIONS.has(permission));
  });
  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    isOakDeskUrl(requestingOrigin || webContents?.getURL() || '') && ALLOWED_PERMISSIONS.has(permission)
  ));
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Oak Desk',
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a1117',
    icon: path.join(__dirname, 'assets', 'app-icon-512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false
    }
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isOakDeskUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  window.loadURL(APP_URL);
}

app.whenReady().then(() => {
  configureSession();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
