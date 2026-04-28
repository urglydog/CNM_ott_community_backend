const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');
const modulesDir = path.join(srcDir, 'modules');
const chatDir = path.join(modulesDir, 'chat');

const targetDirs = {
  bot: path.join(modulesDir, 'bots'),
  call: path.join(modulesDir, 'calls'),
  channel: path.join(modulesDir, 'channels'),
  group: path.join(modulesDir, 'groups'),
  message: path.join(modulesDir, 'messages')
};

// 1. Create target directories
for (const dir of Object.values(targetDirs)) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

// 2. Move files
if (fs.existsSync(chatDir)) {
  const files = fs.readdirSync(chatDir);
  for (const file of files) {
    let targetDir = null;
    if (file.startsWith('bot')) targetDir = targetDirs.bot;
    else if (file.startsWith('call')) targetDir = targetDirs.call;
    else if (file.startsWith('channel')) targetDir = targetDirs.channel;
    else if (file.startsWith('group')) targetDir = targetDirs.group;
    else if (file.startsWith('message')) targetDir = targetDirs.message;

    if (targetDir) {
      const oldPath = path.join(chatDir, file);
      const newPath = path.join(targetDir, file);
      fs.renameSync(oldPath, newPath);
      console.log(`Moved ${file} to ${path.basename(targetDir)}`);
    }
  }

  // Remove chat dir if empty
  const remaining = fs.readdirSync(chatDir);
  if (remaining.length === 0) {
    fs.rmdirSync(chatDir);
    console.log('Removed empty chat directory');
  } else {
    console.log('Chat directory not empty, leaving it alone. Remaining files:', remaining);
  }
} else {
  console.log('Chat directory does not exist or has already been moved.');
}

// 3. Update app.js
const appJsPath = path.join(srcDir, 'app.js');
if (fs.existsSync(appJsPath)) {
  let appJsContent = fs.readFileSync(appJsPath, 'utf8');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/messageRoutes"/g, '"./modules/messages/messageRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/groupRoutes"/g, '"./modules/groups/groupRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/channelRoutes"/g, '"./modules/channels/channelRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/callRoutes"/g, '"./modules/calls/callRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/botRoutes"/g, '"./modules/bots/botRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/messageRevokeRoutes"/g, '"./modules/messages/messageRevokeRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/messageDeleteRoutes"/g, '"./modules/messages/messageDeleteRoutes"');
  appJsContent = appJsContent.replace(/"\.\/modules\/chat\/messageForwardRoutes"/g, '"./modules/messages/messageForwardRoutes"');
  fs.writeFileSync(appJsPath, appJsContent, 'utf8');
  console.log('Updated app.js paths');
}

// 4. Update socketHandler.js
const socketHandlerPath = path.join(srcDir, 'socket', 'socketHandler.js');
if (fs.existsSync(socketHandlerPath)) {
  let socketContent = fs.readFileSync(socketHandlerPath, 'utf8');
  socketContent = socketContent.replace(/"\.\.\/modules\/chat\/messageService"/g, '"../modules/messages/messageService"');
  socketContent = socketContent.replace(/"\.\.\/modules\/chat\/groupService"/g, '"../modules/groups/groupService"');
  fs.writeFileSync(socketHandlerPath, socketContent, 'utf8');
  console.log('Updated socketHandler.js paths');
}

// 5. Update legacy src/routes/*.js
const routesDir = path.join(srcDir, 'routes');
if (fs.existsSync(routesDir)) {
  const routeFiles = fs.readdirSync(routesDir);
  for (const file of routeFiles) {
    if (file.endsWith('.js')) {
      const p = path.join(routesDir, file);
      let c = fs.readFileSync(p, 'utf8');
      if (c.includes('../modules/chat/')) {
        let replacement = '';
        if (file.startsWith('group')) replacement = '../modules/groups/';
        else if (file.startsWith('message')) replacement = '../modules/messages/';
        else if (file.startsWith('channel')) replacement = '../modules/channels/';
        else if (file.startsWith('call')) replacement = '../modules/calls/';
        else if (file.startsWith('bot')) replacement = '../modules/bots/';
        else replacement = '../modules/chat/';
        
        c = c.replace(/\.\.\/modules\/chat\//g, replacement);
        fs.writeFileSync(p, c, 'utf8');
        console.log(`Updated legacy route file ${file}`);
      }
    }
  }
}

console.log('Refactoring completed successfully!');
