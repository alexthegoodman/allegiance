# Allegiance

A political conquest MMO on the full-scale Earth of 2100, in Babylon.js. Found a nation, speak,
organize, and take territory from the regimes and from other players.

## Online

Allegiance is online only. There is no offline mode: when a server can't be reached the game says
so (the title screen, or a red strip on the HUD) and does not fall back to local play.

- **Indie Machine API** (`../indie-machine`, `/api/allegiance`): anonymous sessions and accounts,
  nations and their saves, the territory map between players, world news. Its URL is
  `VITE_ALLEGIANCE_API`: an environment variable on the Vercel project in production
  (`https://indie-machine.com/api/allegiance`), `.env.development` locally. `.env*` files are
  gitignored; `.env.example` is the template.
- **allegiance-realtime** (`../allegiance-realtime`, Cloudflare Durable Objects): other players
  in your map cell, refereed street fights, live territory and news.

The title has two choices: **New Nation / New Party** (founds a nation on the server; an older
one is dissolved and its territory returns to the regimes) and **Continue**. Players start
anonymous; **Create account** (HUD, or the command console) keeps the nation under an email and
password, and **Sign in** opens it on another device. Leaving with an anonymous nation asks first.

Each client still runs the strategic sim against the regimes; the server is the record of who holds
what between players (`src/game/al_net.ts`, `src/game/al_online.ts`, `src/net/`). Taking a region
another nation holds is decided by the server from both sides' troops.

## Develop

```bash
npm install
cp .env.example .env.development
# in ../indie-machine: npm run db:dev, then npm run dev (:3000)
# in ../allegiance-realtime: npm run dev (:8787)
npm run dev                 # :5190
npm run typecheck
npm run test:unit
node tests/bdd/mmo.mjs      # tests/features/mmo_two_players.feature, two browsers (BDD_PORT to move off :5190)
```
