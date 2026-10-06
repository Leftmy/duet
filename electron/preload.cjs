const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Feature modules talk over namespaced channels through call/subscribe.
const FEATURE_PREFIXES = ['pr:', 'search:', 'sched:', 'voice:', 'instr:', 'fs:', 'tg:', 'win:', 'cmd:', 'desk:'];
const allowed = (ch) => typeof ch === 'string' && FEATURE_PREFIXES.some((p) => ch.startsWith(p));

contextBridge.exposeInMainWorld('desk', {
  call: (channel, ...args) => (allowed(channel) ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('Channel not allowed: ' + channel))),
  subscribe: (channel, cb) => {
    if (!allowed(channel)) return () => {};
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform,
  // Real filesystem path of a dropped/pasted File (Electron no longer exposes File.path).
  getPathForFile: (file) => webUtils.getPathForFile(file),
  probe: invoke('claude:probe'),
  usage: invoke('claude:usage'),
  listSessions: invoke('claude:listSessions'),
  loadSession: invoke('claude:loadSession'),
  segments: invoke('claude:segments'),
  renameSession: invoke('claude:renameSession'),
  deleteSession: invoke('claude:deleteSession'),
  send: invoke('claude:send'),
  configure: invoke('claude:configure'),
  interrupt: invoke('claude:interrupt'),
  respondPermission: invoke('claude:respondPermission'),
  closeThread: invoke('claude:closeThread'),
  autoTitle: invoke('claude:autoTitle'),
  stopTask: invoke('claude:stopTask'),
  loadSubagents: invoke('claude:loadSubagents'),
  contextUsage: invoke('claude:contextUsage'),
  browserSetBounds: invoke('browser:setBounds'),
  browserSetVisible: invoke('browser:setVisible'),
  browserNavigate: invoke('browser:navigate'),
  browserControl: invoke('browser:control'),
  browserState: invoke('browser:state'),
  onBrowserState: on('browser:state'),
  onBrowserShow: on('browser:show'),
  filesList: invoke('files:list'),
  filesRead: invoke('files:read'),
  filesWrite: invoke('files:write'),
  filesWatch: invoke('files:watch'),
  filesUnwatch: invoke('files:unwatch'),
  onFileChanged: on('files:changed'),
  termCreate: invoke('term:create'),
  termWrite: invoke('term:write'),
  termResize: invoke('term:resize'),
  termKill: invoke('term:kill'),
  onTermData: on('term:data'),
  onTermExit: on('term:exit'),
  statsSummary: invoke('stats:summary'),
  mcpStatus: invoke('mcp:status'),
  mcpReconnect: invoke('mcp:reconnect'),
  mcpAdd: invoke('mcp:add'),
  mcpRemove: invoke('mcp:remove'),
  buildInfo: invoke('app:buildInfo'),
  rebuild: invoke('app:rebuild'),
  relaunch: invoke('app:relaunch'),
  onUpdateAvailable: on('app:update-available'),
  wtIsRepo: invoke('wt:isRepo'),
  wtCreate: invoke('wt:create'),
  wtApply: invoke('wt:apply'),
  wtRemove: invoke('wt:remove'),
  wtAll: invoke('wt:all'),
  rewind: invoke('claude:rewind'),
  fork: invoke('claude:fork'),
  rewindConversation: invoke('claude:rewindConversation'),
  backgroundTask: invoke('claude:backgroundTask'),
  taskOutput: invoke('claude:taskOutput'),
  gitStatus: invoke('app:gitStatus'),
  gitFileDiff: invoke('app:gitFileDiff'),
  gitCommit: invoke('app:gitCommit'),
  gitPush: invoke('app:gitPush'),
  gitPull: invoke('app:gitPull'),
  gitDiscard: invoke('app:gitDiscard'),
  gitBranches: invoke('app:gitBranches'),
  gitCheckout: invoke('app:gitCheckout'),
  commitMessage: invoke('app:commitMessage'),
  openTargets: invoke('app:openTargets'),
  openIn: invoke('app:openIn'),
  getSettings: invoke('app:getSettings'),
  setSettings: invoke('app:setSettings'),
  setTheme: invoke('app:setTheme'),
  pickFolder: invoke('app:pickFolder'),
  openExternal: invoke('app:openExternal'),
  openPath: invoke('app:openPath'),
  showInFolder: invoke('app:showInFolder'),
  gitBranch: invoke('app:gitBranch'),
  pathExists: invoke('app:pathExists'),
  onEvent: on('claude:event'),
  onPermission: on('claude:permission'),
  onPermissionCancel: on('claude:permission-cancel'),
  onClosed: on('claude:closed'),
});
