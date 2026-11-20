# Home

A small web app that shows the devices on a Homey Pro and the live all-in electricity price for DK1.

- Sign in with your Homey account (OAuth, read-only access to rooms, devices, Insights and energy).
- Devices update every 15 seconds. At home it talks to the Homey on the local network; away it uses Homey's remote connection.
- Prices come from Energi Data Service (DayAheadPrices, 15-minute) and are turned into an all-in price with the tariffs in `config.js`.
- Light and dark themes follow the phone, or can be set in Settings.

Open it at https://joakimasmussen.github.io/homey-smart-home/ and add it to the home screen. Add `?demo` to the address to see it with sample devices.

## Settings

Edit `config.js`:

- `tariffs`: grid tariff bands, Energinet tariffs, supplier markup, elafgift and VAT in kr/kWh excl. VAT. The grid tariff is a **sample** until the real grid company tariffs are added (`sample: true` shows a note in the app).
- `priceArea`: `DK1` (Jutland and Funen) or `DK2`.

The Homey client ID and secret are in `config.js` too. In a browser app they are visible to anyone, but they only let a person sign in to their own Homey; no data is reachable without a Homey login.

## Files

- `index.html`, `app.css`, `app.js`: the app
- `config.js`: settings
- `demo.js`: sample data for `?demo`
- `manifest.webmanifest`, `icon*.png`, `icon.svg`: home screen icon
