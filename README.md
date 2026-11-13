# RAYU CODE · Spin & Win (FrancoTech 2026)

A fullscreen spin wheel for the Rayu Code booth. It works completely offline:
no internet, no installation, no server.

## How to use it on Windows

1. **Extract the ZIP.** Right-click `rayu-spin-and-win.zip` → *Extract All…* → *Extract*.
2. **Double-click `index.html`.** It opens in Microsoft Edge or Google Chrome.
3. **Press F11** for fullscreen (or click the ⛶ button at the top right). Press F11 again to leave.
4. The visitor clicks **SPIN NOW**.
5. When the wheel stops, the popup shows the winning discount. Issue that discount
   with the Rayu Code coupon website.
6. Click **SPIN AGAIN** to reset the wheel for the next visitor.

The popup never closes by itself. Clicking outside it or pressing Esc does nothing;
only **SPIN AGAIN** closes it.

## Controls

| Control | What it does |
|---|---|
| SPIN NOW (or Enter / Space) | Spins the wheel. Disabled while spinning. |
| SPIN AGAIN | Closes the result and gets the wheel ready. |
| ⏱ button (or **S**) | Spin time: drag the slider from 3 s to 15 s. Default is 6 s. The setting is saved on this laptop. "Reset to default" returns to 6 s. Prize chances never change. |
| 🔊 button (or **M**) | Sound on/off. Sound is on by default. |
| ⛶ button (or **F**) | Fullscreen on/off. |

Sound starts after the first click (browser rule). Keep the laptop volume up.

## Prizes and fairness

The wheel has four equal 90° sections: **30%, 50%, 70% and 100% OFF**.
Each prize has exactly a 25% chance on every spin.

- The prize is chosen with `crypto.getRandomValues()` *before* the wheel starts moving
  (`js/fairness.js`, function `pickPrizeIndex`). There is no weighting, no memory of
  earlier spins, and no limit on spins.
- The wheel is then rotated to a random spot inside that section, at least 15° from
  either edge, so it never stops on a line.
- The popup reads the prize from the section that is physically under the pointer.
- No visitor data is collected or stored.

## Files

```
index.html               the page
style.css                design (Rayu Code colours as CSS variables)
js/fairness.js           random prize choice + wheel geometry
js/sound.js              sound effects (Web Audio API, no audio files)
js/effects.js            background particles + confetti
js/app.js                wheel drawing, spin animation, popup
assets/rayucode-logo.png official Rayu Code logo (local copy)
tests/                   optional checks for developers (need Node.js)
```

## Optional developer checks

These are not needed to run the wheel.

```
node tests/simulate.js 1000000     # 1,000,000 draws: frequency + chi-square + geometry
node tests/browser-check.mjs 16    # real Edge, offline: 16 spins, layout, sound, popup
```

## Troubleshooting

- **Lag on a phone or tablet:** the page switches to a lighter look automatically on
  touch, small or low-memory devices (same design, fewer glows and animations). To force
  it on any device, add `?lite=1` to the address, e.g. `index.html?lite=1`. Use `?lite=0`
  to force the full effects.
- **No sound:** click the 🔊 button once and check the Windows volume.
- **Wheel looks too small or too big:** press F11 for fullscreen, and reset browser
  zoom with Ctrl + 0.
- **Accessibility:** if Windows "Animation effects" is turned off, the wheel uses a
  short, gentle spin and lighter effects.
