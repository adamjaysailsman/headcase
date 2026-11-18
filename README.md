# Headcase

A party guessing game for phones. One person starts a room, everyone joins with a four-letter code,
and each player writes a person, place or thing for the player on their left. Everyone sees it except them.

No database. Rooms live in memory and disappear when the server restarts. The server never sends a player
their own word until it is revealed.

## Run it on your computer

    npm install
    npm start

Open http://localhost:3000 (phones on the same wifi can use your computer's address).

## Put it online with Render (free)

1. Put these files in a GitHub repository: `server.js`, `index.html`, `package.json`, `render.yaml`.
2. On render.com, choose New, then Blueprint, pick the repository, and approve.
3. When the deploy finishes, Render shows your link, like `https://headcase.onrender.com`.

Optional: in the service's Environment tab, add `ACCESS_PASSWORD` with any word. Players are asked for it once.

Free services sleep after 15 minutes without traffic, so the first visit after a quiet spell takes up to a minute.
