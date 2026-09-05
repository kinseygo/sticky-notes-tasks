const { app } = require('electron');
const path = require('path');
app.setPath('userData', path.join(app.getPath('appData'), 'sticky-notes-tasks'));
console.log('[dbg] userData =', app.getPath('userData'));
process.on('uncaughtException', e => console.log('[dbg] UNCAUGHT:', e.stack));
process.on('exit', c => console.log('[dbg] process exit', c));
app.on('will-quit', (_e, code) => console.log('[dbg] will-quit, code =', code));
require('./main.js');
console.log('[dbg] main.js required OK, lock =', app.requestSingleInstanceLock());
