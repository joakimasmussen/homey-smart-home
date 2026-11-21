// Settings for the Home app. Change values here, then upload this file again.
window.APP_CONFIG = {
  // Homey Web API client "Home energy" (tools.developer.homey.app → My API Clients).
  // In a browser app these are visible to anyone; they only let a person sign in to their OWN Homey.
  clientId: '6b0097cc917947d5eedcd13b',
  clientSecret: '4bd7ec7784aa4e0e65226fb3709dc969',
  redirectUri: 'https://joakimasmussen.github.io/homey-smart-home/',

  priceArea: 'DK1',

  // kr per kWh excluding VAT. SAMPLE values until the real grid company tariffs are added.
  tariffs: {
    sample: true,
    grid: [
      { from: 0, to: 6, kr: 0.13 },
      { from: 6, to: 17, kr: 0.39 },
      { from: 17, to: 21, kr: 1.02 },
      { from: 21, to: 24, kr: 0.39 },
    ],
    energinet: 0.14,
    supplierMarkup: 0.0776,
    elafgift: 0.008, // 2026–27 rate, 0.8 øre/kWh excl. VAT
    vat: 0.25,
  },

  // Outside temperature (Open-Meteo) for the "How the house holds heat" tile.
  location: { name: 'Herning', lat: 56.14, lon: 8.97 },

  // Lines on the "How the house holds heat" tile. Sensors are found by the room (zone) they are in
  // in Homey, so they can be renamed freely; more sensors in the same room are averaged.
  heat: [
    { key: 'ground', label: 'Ground floor', short: 'Ground', zones: ['Køkken'] },
    { key: 'south', label: '1st floor south', short: '1st S', zones: ['Soveværelse (1. Sal)'] },
    { key: 'north', label: '1st floor north', short: '1st N', zones: ['Stue (1. Sal)'] },
  ],

  refreshSeconds: 15,
};
