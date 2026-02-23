# PhantomChat — Full Stack

Real-time ephemeral chat over WebSocket. Private (2-person) and Group (unlimited) rooms that **self-destruct in 24 hours**.

## Project Structure

```
phantom-chat/
├── server.js          ← Node.js WebSocket + Express server
├── package.json
└── public/
    └── index.html 
    |___index.css    ← Frontend 
```

## Run Locally

```bash
npm install
npm start
# → http://localhost:3000
```


## Env Variables

| Variable | Default | Notes |
|---|---|---|
| PORT | 3000 | Set automatically by hosting platforms |
