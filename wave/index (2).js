const { Client, MessageTypes } = require('./macsploit.js');

(async () => {
  const client = new Client();

  // 5553 ~ 5562 for each roblox window (max 10)
  const attached = await client.attach(5553).catch(err => err);
  if (attached instanceof Error) {
    console.log('Attach failed:', attached);
    return;
  }
  console.log('Attached to port:', 5553);

  client.on('message', (message, type) => {
    switch (type) {
      case MessageTypes.PRINT:
        console.log('[Debug]', message);
        break;
      case MessageTypes.ERROR:
        console.error('[Error]', message);
        break;
    }
  });

  client.executeScript("print('Hello World!')\nerror('Goodbye World!')");
  console.log('Executed sample print script.');

  setTimeout(async () => {
    const detached = await client.detach().catch(err => err);
    if (detached instanceof Error) {
      console.log('Detach failed:', detached);
      return;
    }

    console.log('Detached.');
  }, 1000);
})();
