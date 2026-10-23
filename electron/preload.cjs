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
  probe: invoke('agent:probe'),
  usage: invoke('agent:usage'),
  listSessions: invoke('agent:listSessions'),
  loadSession: invoke('agent:loadSession'),
  segments: invoke('agent:segments'),
  renameSession: invoke('agent:renameSession'),
  deleteSession: invoke('agent:deleteSession'),
  send: invoke('agent:send'),
  configure: invoke('agent:configure'),
  interrupt: invoke('agent:interrupt'),
  respondPermission: invoke('agent:respondPermission'),
  closeThread: invoke('agent:closeThread'),
  autoTitle: invoke('agent:autoTitle'),
  stopTask: invoke('agent:stopTask'),
  loadSubagents: invoke('agent:loadSubagents'),
  contextUsage: invoke('agent:contextUsage'),
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
  rewind: invoke('agent:rewind'),
  fork: invoke('agent:fork'),
  rewindConversation: invoke('agent:rewindConversation'),
  backgroundTask: invoke('agent:backgroundTask'),
  taskOutput: invoke('agent:taskOutput'),
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
  onEvents: (cb) => {
    // A newly opened window may have this preload while the core is still the
    // previous version. Accept both transports during a non-disruptive update.
    const offSingle = on('agent:event')((payload) => cb([payload]));
    const offBatch = on('agent:events')(cb);
    return () => { offSingle(); offBatch(); };
  },
  onEvent: (cb) => {
    const offSingle = on('agent:event')(cb);
    const offBatch = on('agent:events')((batch) => { for (const payload of batch) cb(payload); });
    return () => { offSingle(); offBatch(); };
  },
  onPermission: on('agent:permission'),
  onPermissionCancel: on('agent:permission-cancel'),
  onClosed: on('agent:closed'),
});
