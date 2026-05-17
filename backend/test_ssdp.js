const dgram = require('dgram');
const s = dgram.createSocket('udp4');

const msg = 'M-SEARCH * HTTP/1.1\r\n' +
            'HOST:239.255.255.250:1900\r\n' +
            'ST:urn:dial-multiscreen-org:service:dial:1\r\n' +
            'MX:2\r\n' +
            'MAN:"ssdp:discover"\r\n\r\n';

s.on('message', (msg, info) => {
  console.log(`Received from ${info.address}:${info.port}:\n${msg}`);
});

s.send(msg, 1900, '192.168.0.12', (err) => {
  if (err) console.error(err);
});

setTimeout(() => {
  console.log('Timeout');
  process.exit(0);
}, 3000);
