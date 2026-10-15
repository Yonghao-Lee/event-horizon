# Event Horizon

A browser game where you play as a black hole. It renders gravitational lensing in real time.

**▶ Play it: http://chicoryman.com/event-horizon/**

Eat anything smaller than you and tear apart anything bigger. Climb four ranks, then take on **The Great Attractor**.

## How to play

| Action | Controls |
|---|---|
| Move | Mouse, or arrow keys / WASD |
| Boost (costs mass) | Hold click, or hold Space |
| Pause | P or Esc |
| Start | Click, or Space |

- **Blue** holes are smaller than you, so you can eat them. **Red** holes are bigger, so stay away.
- If a rival eats too much too fast, it goes **quasar**: it fires off jets and shrinks. That's your chance to strike.
- Ranks: Asteroid Devourer → Planet Eater → Star Swallower → Galaxy Ender.
- At the final rank, the boss appears. Outgrow it, then eat it to win.
- You have 3 lives. Your best mass and fastest win are saved in your browser.
- Cows, pizza and rubber ducks are fair game.

## How it works

- The world is drawn to an offscreen 2D canvas.
- A WebGL fragment shader then bends that image around each black hole. It also draws the accretion disks, shadows and photon rings.
- Objects that come too close stretch toward the hole (spaghettification). Ones too big to swallow get torn apart by tidal forces.
- All sound is synthesized live with the Web Audio API. There are no audio files.
- If WebGL isn't available, the game falls back to plain 2D drawing.

It has no dependencies and no build step. The whole game is `index.html` + `game.js`.

## Run locally

Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server
# then open http://localhost:8000
```
