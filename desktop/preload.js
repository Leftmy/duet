// Native WebView bridge. This script is injected only into trusted application views.
(() => {
  const listeners = new Map();
  const transport = {
    invoke: (channel, ...args) => window.__TAURI_INTERNALS__.invoke('duet_invoke', {channel, args}),
    on: (channel, fn) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel).add(fn); },
    removeListener: (channel, fn) => listeners.get(channel)?.delete(fn),
  };
  window.__duetDeliver = (channel, payload) => {
    for (const fn of [...(listeners.get(channel) || [])]) fn({}, payload);
  };
  const invoke = channel => (...args) => transport.invoke(channel, ...args);
  const on = channel => cb => { const fn=(_event,payload)=>cb(payload);transport.on(channel,fn);return()=>transport.removeListener(channel,fn); };
  const FEATURE_PREFIXES = ['pr:', 'search:', 'sched:', 'voice:', 'instr:', 'fs:', 'tg:', 'win:', 'cmd:', 'desk:'];
  const allowed = channel => typeof channel === 'string' && FEATURE_PREFIXES.some(prefix => channel.startsWith(prefix));
  window.Notification = class extends EventTarget {
    static permission = 'granted';
    static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, options={}) { super();transport.invoke('desk:notification',{title,body:options.body||''}); }
    close() {}
  };
  window.desk = {
  call: (channel, ...args) => (allowed(channel) ? transport.invoke(channel, ...args) : Promise.reject(new Error('Channel not allowed: ' + channel))),
  subscribe: (channel, cb) => {
    if (!allowed(channel)) return () => {};
    const h = (_e, payload) => cb(payload);
    transport.on(channel, h);
    return () => transport.removeListener(channel, h);
  },
  platform: __DUET_PLATFORM__,
  nativeHistoryPaging: true,
  nativeContext: true,
  loadSessionPage: invoke('agent:loadSessionPage'),
  loadSubagentPage: invoke('agent:loadSubagentPage'),
  // Native file-drop paths are attached by the host.
  getPathForFile: (file) => file.__duetPath || '',
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
  browserScreenshot: invoke('browser:screenshot'),
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
};
})();
