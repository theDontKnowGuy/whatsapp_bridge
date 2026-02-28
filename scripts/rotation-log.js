const fs = require('fs');
const path = require('path');
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_PATH = path.join(LOG_DIR, 'bridge.log');
if (fs.existsSync(LOG_PATH)) {
  fs.renameSync(LOG_PATH, path.join(LOG_DIR, `bridge-${Date.now()}.log`));
}
