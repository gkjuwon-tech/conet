const fs = require('fs');
const os = require('os');
const path = require('path');
const storePath = path.join(os.homedir(), '.config', 'electromesh', 'config.json');
fs.mkdirSync(path.dirname(storePath), { recursive: true });
fs.writeFileSync(storePath, JSON.stringify({
  userToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMUtSNjRXOFo1WTJKQjdKM1hGUTAzNVBSWSIsImtpbmQiOiJ1c2VyIiwic2NvcGUiOlsidXNlci4qIl0sImlhdCI6MTc3ODMyMjkxNywiZXhwIjoxNzc4MzY2MTE3LCJpc3MiOiJlbGVjdHJvbWVzaC1hcGkifQ.tJ5PfbcEfV-GcWqz0a-L4b7zBWBaepZ4G0c4PSPNLYI'
}));
console.log('Done');