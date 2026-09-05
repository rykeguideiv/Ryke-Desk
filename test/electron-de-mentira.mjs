const naoFaz = () => undefined;
export const app = {
  getPath: () => process.cwd(),
  getAppPath: () => process.cwd(),
  isPackaged: false,
  on: naoFaz,
  quit: naoFaz,
  exit: naoFaz,
  relaunch: naoFaz,
};
export const ipcMain = { on: naoFaz, handle: naoFaz };
export const BrowserWindow = class {};
export const screen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) };
export const shell = { openPath: naoFaz };
export const dialog = {};
export const Notification = class {};
export const clipboard = {};
export const nativeImage = {};
export default { app, ipcMain, BrowserWindow, screen, shell, dialog, Notification, clipboard, nativeImage };
