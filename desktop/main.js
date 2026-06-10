const { app, BrowserWindow, screen, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
const SIGNALING_URL = process.env.HOLO_SIGNALING_URL ?? '';

function getClientIndexPath() {
  if (isDev) {
    const devPath = path.join(__dirname, '../client/dist/index.html');
    if (fs.existsSync(devPath)) return devPath;
    return null;
  }
  return path.join(process.resourcesPath, 'client', 'index.html');
}

function createWindow(hologramMode = false) {
  const displays = screen.getAllDisplays();
  const external = displays.length > 1 ? displays[1] : displays[0];

  const win = new BrowserWindow({
    x: hologramMode ? external.bounds.x : undefined,
    y: hologramMode ? external.bounds.y : undefined,
    width: hologramMode ? external.bounds.width : 1400,
    height: hologramMode ? external.bounds.height : 900,
    fullscreen: hologramMode,
    autoHideMenuBar: !isDev,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: '全息投影 · 多屏互动系统',
  });

  const indexPath = getClientIndexPath();
  const query = { type: 'desktop' };
  if (hologramMode) query.hologram = '1';
  if (SIGNALING_URL) query.server = SIGNALING_URL;

  if (indexPath && fs.existsSync(indexPath)) {
    win.loadFile(indexPath, { query }).catch((err) => {
      const { dialog } = require('electron');
      dialog.showErrorBox('加载失败', `无法打开客户端页面：${err.message}`);
    });
  } else {
    const url = new URL(process.env.HOLO_DEV_URL ?? 'http://localhost:5173');
    url.searchParams.set('type', 'desktop');
    if (SIGNALING_URL) url.searchParams.set('server', SIGNALING_URL);
    if (hologramMode) url.searchParams.set('hologram', '1');
    win.loadURL(url.toString());
  }

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

function buildMenu() {
  const template = [
    {
      label: '视图',
      submenu: [
        { label: '管理员模式', click: (_, w) => w?.webContents.send('app-action', 'toggle-admin') },
        { label: '全息输出', click: () => createWindow(true) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox({
              type: 'info',
              title: '全息投影系统',
              message: '全息投影 · 多屏互动系统 v0.1.0',
              detail: SIGNALING_URL
                ? `信令服务器: ${SIGNALING_URL}`
                : '信令服务器: 使用客户端内置默认地址',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  const hologram = process.argv.includes('--hologram');
  createWindow(hologram);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-signaling-url', () => SIGNALING_URL);
